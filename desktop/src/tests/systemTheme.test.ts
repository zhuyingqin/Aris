// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { useStore } from "../store";

vi.mock("@tauri-apps/api/app", () => ({setTheme: vi.fn(async () => {})}));
vi.mock("../platform", () => ({isMacOS: () => true}));
vi.mock("../api/tauri", async (original) => ({...await original<typeof import("../api/tauri")>(), isTauri: () => true}));
beforeEach(() => {
  localStorage.clear(); vi.stubGlobal("matchMedia", () => ({matches: false}));
  useStore.getState().setTheme("dark"); vi.mocked(setNativeTheme).mockClear();
});

it("clears the native macOS theme override when following the operating system", () => {
  useStore.getState().setTheme("system", {requirePersistence: true});
  expect(setNativeTheme).toHaveBeenLastCalledWith(null);
  expect(useStore.getState()).toMatchObject({themeMode: "system", theme: "light"});
  expect(localStorage.getItem("somniq-theme")).toBe("system");
});

it("keeps explicit native themes and restores automatic mode when another window changes it", () => {
  useStore.getState().setTheme("light"); expect(setNativeTheme).toHaveBeenLastCalledWith("light");
  vi.stubGlobal("matchMedia", () => ({matches: true})); useStore.getState().syncTheme("system");
  expect(setNativeTheme).toHaveBeenLastCalledWith(null);
  expect(useStore.getState()).toMatchObject({themeMode: "system", theme: "dark"});
});

it("restores native automatic mode at startup", async () => {
  localStorage.setItem("somniq-theme", "system"); vi.resetModules();
  const {useStore: restored} = await import("../store");
  expect(restored.getState().themeMode).toBe("system");
  expect(setNativeTheme).toHaveBeenLastCalledWith(null);
});
