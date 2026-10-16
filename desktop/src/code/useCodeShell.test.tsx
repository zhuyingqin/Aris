// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codeBridgeConnected, codeBridgeSetShell, onCodeBridgeConnection,
  onCodeBridgeShellAction, onCodeBridgeShellReady,
} from "../api/tauri";
import type { CodeShellAction } from "./codeShell";
import { useCodeShell } from "./useCodeShell";

vi.mock("../api/tauri", () => ({
  codeBridgeConnected: vi.fn(), codeBridgeSetShell: vi.fn(),
  onCodeBridgeConnection: vi.fn(), onCodeBridgeShellAction: vi.fn(), onCodeBridgeShellReady: vi.fn(),
}));
let connection: (value: boolean) => void;
let action: (value: CodeShellAction) => void;
let ready: (value: number) => void;
const unlisten = vi.fn();
function options() {
  return {
    enabled: true, active: true,
    shell: {
      language: "cn", modules: [{ id: "lab", label: "代码" }, { id: "chat", label: "对话" }],
      projects: [{ id: "p1", name: "work", path: "D:/work" }], currentProjectId: "p1", projectBusy: false,
      account: { name: "Researcher", plan: "Pro", allowance: "$12.50", remainingPercent: 75 },
    },
    onSelectModule: vi.fn(), onSelectProject: vi.fn(), onAddProject: vi.fn(),
    onRevealProject: vi.fn(), onSettings: vi.fn(), onSignOut: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(codeBridgeConnected).mockResolvedValue(true);
  vi.mocked(codeBridgeSetShell).mockResolvedValue(true);
  vi.mocked(onCodeBridgeConnection).mockImplementation((handler) => { connection = handler; return Promise.resolve(unlisten); });
  vi.mocked(onCodeBridgeShellAction).mockImplementation((handler) => { action = handler; return Promise.resolve(unlisten); });
  vi.mocked(onCodeBridgeShellReady).mockImplementation((handler) => { ready = handler; return Promise.resolve(unlisten); });
});
afterEach(cleanup);

describe("useCodeShell", () => {
  it("waits for the latest native controls acknowledgement before removing the header", async () => {
    const opts = options();
    const { result, rerender } = renderHook(useCodeShell, { initialProps: opts });
    await waitFor(() => expect(codeBridgeSetShell).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
    const revision = vi.mocked(codeBridgeSetShell).mock.calls.at(-1)![0];
    act(() => ready(revision - 1));
    expect(result.current).toBe(false);
    act(() => ready(revision));
    expect(result.current).toBe(true);
    rerender({ ...opts, shell: { ...opts.shell, language: "en" } });
    await waitFor(() => expect(codeBridgeSetShell).toHaveBeenCalledTimes(2));
    expect(vi.mocked(codeBridgeSetShell).mock.calls.at(-1)![1].language).toBe("en");
    act(() => connection(false));
    expect(result.current).toBe(false);
    act(() => ready(revision));
    expect(result.current).toBe(false);
    act(() => connection(true));
    await waitFor(() => expect(codeBridgeSetShell).toHaveBeenCalledTimes(3));
    expect(result.current).toBe(false);
    act(() => ready(vi.mocked(codeBridgeSetShell).mock.calls.at(-1)![0]));
    expect(result.current).toBe(true);
  });

  it("resolves only current module/project IDs and ignores actions from the hidden workbench", async () => {
    const opts = options();
    const { rerender } = renderHook(useCodeShell, { initialProps: opts });
    await waitFor(() => expect(codeBridgeSetShell).toHaveBeenCalled());
    act(() => {
      action({ kind: "select-module", id: "chat" });
      action({ kind: "select-module", id: "unknown" });
      action({ kind: "select-project", id: "D:/arbitrary-path" });
      action({ kind: "select-project", id: "p1" });
      action({ kind: "settings" });
    });
    expect(opts.onSelectModule).toHaveBeenCalledTimes(1);
    expect(opts.onSelectModule).toHaveBeenCalledWith("chat");
    expect(opts.onSelectProject).toHaveBeenCalledTimes(1);
    expect(opts.onSelectProject).toHaveBeenCalledWith("p1");
    expect(opts.onSettings).toHaveBeenCalledTimes(1);
    rerender({ ...opts, shell: { ...opts.shell, projectBusy: true } });
    act(() => { action({ kind: "select-project", id: "p1" }); action({ kind: "add-project" }); });
    expect(opts.onSelectProject).toHaveBeenCalledTimes(1);
    expect(opts.onAddProject).not.toHaveBeenCalled();
    rerender({ ...opts, active: false });
    act(() => action({ kind: "sign-out" }));
    expect(opts.onSignOut).not.toHaveBeenCalled();
  });

  it("keeps the header if delivery fails and cleans up every listener", async () => {
    vi.mocked(codeBridgeSetShell).mockResolvedValue(false);
    const { result, unmount } = renderHook(useCodeShell, { initialProps: options() });
    await waitFor(() => expect(codeBridgeSetShell).toHaveBeenCalled());
    expect(result.current).toBe(false);
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("does not connect until Code has mounted", () => {
    renderHook(useCodeShell, { initialProps: { ...options(), enabled: false } });
    expect(codeBridgeConnected).not.toHaveBeenCalled();
    expect(onCodeBridgeConnection).not.toHaveBeenCalled();
  });
});
