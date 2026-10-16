// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTauri, onScreenshotAttachment } from "../api/tauri";
import { useStore } from "../store";
import { usePendingScreenshot } from "./usePendingScreenshot";

vi.mock("../api/tauri", () => ({isTauri: vi.fn(), onScreenshotAttachment: vi.fn()}));
vi.mock("../store", () => ({useStore: {getState: () => ({addPendingChatAttachment: add, setTab: tab})}}));
const {add, tab} = vi.hoisted(() => ({add: vi.fn(), tab: vi.fn()}));
beforeEach(() => { vi.mocked(isTauri).mockReturnValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("does not subscribe to native screenshot events in browser preview", () => {
  vi.mocked(isTauri).mockReturnValue(false); renderHook(usePendingScreenshot);
  expect(onScreenshotAttachment).not.toHaveBeenCalled();
});

it("stages native captures for chat and unsubscribes after unmount", async () => {
  let receive!: Parameters<typeof onScreenshotAttachment>[0]; const stop = vi.fn();
  vi.mocked(onScreenshotAttachment).mockImplementation(async (handler) => {receive = handler; return stop;});
  const view = renderHook(usePendingScreenshot); await Promise.resolve();
  receive({path: "uploads/capture.png", name: "capture.png", preview: "data:image/png;base64,test"});
  expect(useStore.getState().addPendingChatAttachment).toHaveBeenCalledWith(expect.objectContaining({kind: "image", path: "uploads/capture.png", mimeType: "image/png"}));
  expect(tab).toHaveBeenCalledWith("chat"); view.unmount(); expect(stop).toHaveBeenCalledOnce();
  receive({path: "uploads/late.png", name: "late.png", preview: null}); expect(add).toHaveBeenCalledTimes(1);
});

it("cleans up a subscription that resolves after unmount", async () => {
  let resolve!: (stop: () => void) => void;
  vi.mocked(onScreenshotAttachment).mockReturnValue(new Promise((done) => {resolve = done;}));
  const view = renderHook(usePendingScreenshot); view.unmount(); const stop = vi.fn(); resolve(stop);
  await Promise.resolve(); expect(stop).toHaveBeenCalledOnce();
});
