// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configSet } from "../api/tauri";
import type { ConfigPatch, ConfigView } from "../types";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";
import { useModelAutoSave } from "./useModelAutoSave";

vi.mock("../api/tauri", () => ({ configSet: vi.fn(), isTauri: () => true }));
const baseline = PREVIEW_SETTINGS_DATA.cn.configView;
function setup() {
  return renderHook(() => {
    const [configView, setConfigView] = useState<ConfigView | null>(baseline);
    const [draft, setDraft] = useState<ConfigPatch>({});
    const [key, setKey] = useState("");
    const saving = useModelAutoSave({ configView, setConfigView, draft, setDraft, language: "cn",
      secrets: [{ field: "scopusApiKey", present: "hasScopusKey", masked: "scopusKeyMasked", value: key, setValue: setKey }],
    });
    return { configView, setConfigView, draft, setDraft, key, setKey, saving };
  });
}
const advance = (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(configSet).mockReset().mockImplementation(async (patch) => ({ ...baseline, ...patch, hasScopusKey: true, scopusKeyMasked: "masked" }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("debounces edits and saves only model parameters without retaining plaintext in ConfigView", async () => {
  const { result } = setup();
  await advance(1000);
  expect(configSet).not.toHaveBeenCalled();
  act(() => { result.current.setDraft({ webProxyUrl: "first", language: "en", memoryWriteApproval: true }); result.current.setKey(" first-key "); });
  await advance(300);
  act(() => result.current.setDraft((draft) => ({ ...draft, webProxyUrl: "latest" })));
  await advance(499);
  expect(configSet).not.toHaveBeenCalled();
  await advance(1);
  expect(configSet).toHaveBeenCalledTimes(1);
  expect(configSet).toHaveBeenLastCalledWith({ webProxyUrl: "latest", scopusApiKey: "first-key" });
  expect(result.current.key).toBe("");
  expect(result.current.configView).not.toHaveProperty("scopusApiKey");
  expect(result.current.configView?.scopusKeyMasked).toBe("masked");
});

it("serializes writes and preserves newer edits and independently saved preferences", async () => {
  let finish!: (view: ConfigView) => void;
  vi.mocked(configSet).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { result } = setup();
  act(() => { result.current.setDraft({ webProxyUrl: "first" }); result.current.setKey("first-key"); });
  await advance(500);
  act(() => {
    result.current.setDraft({ webProxyUrl: "second" });
    result.current.setKey("second-key");
    result.current.setConfigView((view) => view ? { ...view, language: "en", memoryWriteApproval: !baseline.memoryWriteApproval } : view);
  });
  await advance(1000);
  expect(configSet).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ...baseline, webProxyUrl: "first" }); });
  expect(result.current.key).toBe("second-key");
  expect(result.current.draft.webProxyUrl).toBe("second");
  expect(result.current.configView?.language).toBe("en");
  expect(result.current.configView?.memoryWriteApproval).toBe(!baseline.memoryWriteApproval);
  await advance(500);
  expect(configSet).toHaveBeenLastCalledWith({ webProxyUrl: "second", scopusApiKey: "second-key" });
  expect(result.current.key).toBe("");
});

it("keeps failed drafts without a retry loop and saves them after explicit retry", async () => {
  vi.mocked(configSet).mockRejectedValueOnce(new Error("Disk is read-only"));
  const { result } = setup();
  act(() => result.current.setKey("pending-key"));
  await advance(500);
  expect(result.current.saving.error).toBeTruthy();
  expect(result.current.key).toBe("pending-key");
  await advance(5000);
  expect(configSet).toHaveBeenCalledTimes(1);
  act(() => result.current.saving.retry());
  await advance(500);
  expect(configSet).toHaveBeenCalledTimes(2);
  expect(result.current.saving.error).toBe("");
  expect(result.current.key).toBe("");
});

it("accepts server normalization without repeatedly saving the same input", async () => {
  vi.mocked(configSet).mockResolvedValueOnce({ ...baseline, webProxyUrl: "https://proxy.example" });
  const { result } = setup();
  act(() => result.current.setDraft({ webProxyUrl: " https://proxy.example " }));
  await advance(500);
  expect(result.current.draft.webProxyUrl).toBe("https://proxy.example");
  await advance(2000);
  expect(configSet).toHaveBeenCalledTimes(1);
});

it("flushes the debounce when leaving Settings", async () => {
  const { result, unmount } = setup();
  act(() => result.current.setKey("last-edit"));
  unmount();
  await act(async () => {});
  expect(configSet).toHaveBeenCalledTimes(1);
  expect(configSet).toHaveBeenLastCalledWith({ scopusApiKey: "last-edit" });
  await advance(1000);
  expect(configSet).toHaveBeenCalledTimes(1);
});

it("finishes newer edits after leaving while a save is pending", async () => {
  let finish!: (view: ConfigView) => void;
  vi.mocked(configSet).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { result, unmount } = setup();
  act(() => result.current.setKey("first-key"));
  await advance(500);
  act(() => result.current.setKey("last-edit"));
  unmount();
  expect(configSet).toHaveBeenCalledTimes(1);
  await act(async () => { finish(baseline); });
  expect(configSet).toHaveBeenCalledTimes(2);
  expect(configSet).toHaveBeenLastCalledWith({ scopusApiKey: "last-edit" });
});
