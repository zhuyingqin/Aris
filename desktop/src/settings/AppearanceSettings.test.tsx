// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, useAppearance } from "../appearance";
import { exportAppearancePreset } from "../appearanceTransfer";
import { getEditorSettings, syncEditorSettings } from "../editor/editorSettings";
import { prepareWallpaper, readWallpaperAsset, writeWallpaperAsset } from "../chatWallpaper";
import { useStore } from "../store";
import AppearanceSettings from "./AppearanceSettings";
import { usePreferenceSave } from "./usePreferenceSave";

vi.mock("../chatWallpaper", () => ({prepareWallpaper: vi.fn(), readWallpaperAsset: vi.fn(), writeWallpaperAsset: vi.fn()}));
function Page({section = "basic"}: {section?: "basic" | "chat" | "advanced"}) {
  const preferences = usePreferenceSave();
  return <AppearanceSettings language="cn" preferences={preferences} section={section} />;
}
beforeEach(() => {
  localStorage.clear(); useAppearance.getState().sync(null); syncEditorSettings(null); useStore.getState().setTheme("light");
  vi.mocked(readWallpaperAsset).mockResolvedValue(undefined);
  vi.mocked(writeWallpaperAsset).mockResolvedValue(undefined);
  vi.mocked(prepareWallpaper).mockResolvedValue({blob: new Blob(["image"], {type: "image/webp"}), name: "local.webp"});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("changes common appearance settings and reports failed writes locally with retry", async () => {
  render(<Page />);
  fireEvent.change(screen.getByRole("combobox", {name: "界面字体"}), {target: {value: "serif"}});
  expect(document.documentElement.dataset.uiFont).toBe("serif");
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {throw new Error("denied");});
  fireEvent.change(screen.getByRole("combobox", {name: "背景风格"}), {target: {value: "warm"}});
  expect(screen.getByRole("alert").textContent).toContain("保留原设置");
  expect(useAppearance.getState().value.surface).toBe("default");
  fireEvent.click(screen.getByRole("button", {name: "重试"}));
  expect(useAppearance.getState().value).toMatchObject({surface: "warm", font: "serif"});
  expect(screen.queryByRole("alert")).toBeNull();
});

it("provides built-in wallpapers, opacity, fit, and a readable live preview", () => {
  render(<Page section="chat" />);
  expect(screen.queryByRole("slider", {name: "图片透明度"})).toBeNull();
  fireEvent.click(screen.getByRole("radio", {name: "远山"}));
  fireEvent.change(screen.getByRole("slider", {name: "图片透明度"}), {target: {value: "25"}});
  fireEvent.change(screen.getByRole("combobox", {name: "显示方式"}), {target: {value: "tile"}});
  expect(useAppearance.getState().value).toMatchObject({wallpaper: "mountains", wallpaperOpacity: 25, wallpaperFit: "tile"});
  expect(document.documentElement.style.getPropertyValue("--wallpaper-repeat")).toBe("repeat");
  expect(screen.getByRole("group", {name: "实时预览"})).toBeTruthy();
});

it("stores local images separately and removes them without contacting a server", async () => {
  render(<Page section="chat" />);
  fireEvent.change(screen.getByLabelText("导入图片", {selector: "input"}), {target: {files: [new File(["img"], "local.webp", {type: "image/webp"})]}});
  await screen.findByText("local.webp");
  expect(writeWallpaperAsset).toHaveBeenCalledWith(expect.objectContaining({name: "local.webp", blob: expect.any(Blob)}));
  expect(localStorage.getItem(APPEARANCE_KEY)).not.toContain("data:image");
  expect(useAppearance.getState().value.wallpaper).toBe("custom");
  fireEvent.click(screen.getByRole("button", {name: "移除图片"}));
  await waitFor(() => expect(useAppearance.getState().value.wallpaper).toBe("none"));
  expect(writeWallpaperAsset).toHaveBeenLastCalledWith(undefined);
});

it("restores the previous image asset when preference storage rejects the upload", async () => {
  const previous = {blob: new Blob(["old"]), name: "old.webp"};
  vi.mocked(readWallpaperAsset).mockResolvedValue(previous);
  useAppearance.getState().patch({wallpaper: "custom", wallpaperName: "old.webp"});
  render(<Page section="chat" />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {throw new Error("quota");});
  fireEvent.change(screen.getByLabelText("导入图片", {selector: "input"}), {target: {files: [new File(["img"], "new.webp", {type: "image/webp"})]}});
  await screen.findByRole("alert");
  expect(writeWallpaperAsset).toHaveBeenLastCalledWith(previous);
  expect(useAppearance.getState().value.wallpaperName).toBe("old.webp");
  expect(screen.queryByText("已保存")).toBeNull();
});

it("reuses confirmed editor settings and applies advanced reading preferences", () => {
  render(<Page section="advanced" />);
  fireEvent.change(screen.getByRole("combobox", {name: "正文字号"}), {target: {value: "manual"}});
  fireEvent.change(screen.getByRole("slider", {name: "聊天正文字号"}), {target: {value: "22"}});
  fireEvent.change(screen.getByRole("combobox", {name: "阅读宽度"}), {target: {value: "wide"}});
  fireEvent.change(screen.getByRole("combobox", {name: "界面密度"}), {target: {value: "compact"}});
  fireEvent.click(screen.getByRole("switch", {name: "减少动画"}));
  fireEvent.change(screen.getByRole("combobox", {name: "编辑器字号"}), {target: {value: "18"}});
  expect(useAppearance.getState().value).toMatchObject({bodySize: 22, readingWidth: "wide", density: "compact", reducedMotion: true});
  expect(getEditorSettings().fontSize).toBe(18);
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {throw new Error("quota");});
  fireEvent.change(screen.getByRole("combobox", {name: "编辑器字号"}), {target: {value: "22"}});
  expect(getEditorSettings().fontSize).toBe(18);
  expect(screen.getByRole("alert").textContent).toContain("保留原设置");
});

it("imports a validated local theme and resets appearance with the same shared controls", async () => {
  render(<Page section="advanced" />);
  const preset = JSON.parse(exportAppearancePreset()); preset.appearance.surface = "cool"; preset.appearance.bodySize = 18; preset.theme = "dark";
  const file = new File([JSON.stringify(preset)], "theme.json", {type: "application/json"});
  Object.defineProperty(file, "text", {value: async () => JSON.stringify(preset)});
  fireEvent.change(screen.getByLabelText("导入主题", {selector: "input"}), {target: {files: [file]}});
  await waitFor(() => expect(useStore.getState().theme).toBe("dark"));
  expect(useAppearance.getState().value.surface).toBe("cool");
  fireEvent.click(screen.getByRole("button", {name: "恢复默认"}));
  expect(useStore.getState().themeMode).toBe("system");
  expect(useAppearance.getState().value.bodySize).toBe(0);
  expect(useAppearance.getState().value.surface).toBe("default");
});
