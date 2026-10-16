// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeShellAction } from "../code/codeShell";
import { useStore } from "../store";
import App from "../App";

const bridge = vi.hoisted(() => ({
  action: null as ((action: CodeShellAction) => void) | null,
  connection: null as ((connected: boolean) => void) | null,
  ready: null as ((revision: number) => void) | null,
}));
vi.mock("../api/tauri", async (original) => ({
  ...await original<typeof import("../api/tauri")>(),
  isTauri: () => false,
  codeBridgeConnected: async () => true,
  codeBridgeSetShell: async (revision: number) => { bridge.ready?.(revision); return true; },
  onCodeBridgeShellAction: async (handler: typeof bridge.action) => { bridge.action = handler; return () => { bridge.action = null; }; },
  onCodeBridgeShellReady: async (handler: typeof bridge.ready) => { bridge.ready = handler; return () => { bridge.ready = null; }; },
  onCodeBridgeConnection: async (handler: typeof bridge.connection) => { bridge.connection = handler; return () => { bridge.connection = null; }; },
}));
vi.mock("../chat/Chat", () => ({ default: () => <section>Chat workspace</section> }));
vi.mock("../settings/Settings", () => ({ default: () => <section>Settings workspace</section> }));
vi.mock("../extensions/Extensions", () => ({ default: () => null }));
vi.mock("../OnboardingTutorial", () => ({ default: () => null }));
vi.mock("../code/CodePane", () => ({
  default: ({ onWorkbenchReadyChange }: { onWorkbenchReadyChange: (ready: boolean) => void }) => {
    useEffect(() => { onWorkbenchReadyChange(true); }, [onWorkbenchReadyChange]);
    return <iframe title="Code workbench" />;
  },
}));
vi.mock("../literature/Literature", () => ({ default: () => null }));
vi.mock("../mail/Mail", () => ({ default: () => null }));
vi.mock("../typeset/Typeset", () => ({ default: () => <section>LaTeX workspace</section> }));
vi.mock("../workflows/Workflows", () => ({ default: () => null }));

const originalState = useStore.getState();
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  useStore.setState({ ...originalState, tab: "lab", language: "cn", init: () => () => {}, error: null });
});
afterEach(() => { cleanup(); useStore.setState(originalState, true); vi.unstubAllGlobals(); });

async function readyApp() {
  const view = render(<App />);
  await waitFor(() => expect(view.container.querySelector(".app-code-shell")).not.toBeNull());
  return view;
}

describe("Code module navigation in the app shell", () => {
  it("keeps the application rail in Figures and preserves its workspace when switching back", async () => {
    const user = userEvent.setup();
    useStore.setState({ tab: "chat" });
    const view = render(<App />);
    await user.click(screen.getByRole("button", { name: "科研绘图" }));
    const workspace = await screen.findByRole("region", { name: "科研绘图应用" });
    await waitFor(() => expect(workspace.closest("[hidden]")).toBeNull());
    await user.type(within(workspace).getByRole("textbox", { name: "图形描述" }), "A points to B");
    const navigation = screen.getByRole("navigation", { name: "SomniQ 功能" });
    expect(within(navigation).getByRole("button", { name: "科研绘图" }).getAttribute("aria-current")).toBe("page");
    await user.click(within(navigation).getByRole("button", { name: "对话" }));
    await waitFor(() => expect(workspace.closest("[hidden]")).not.toBeNull());
    await user.click(within(navigation).getByRole("button", { name: "科研绘图" }));
    await waitFor(() => expect(workspace.closest("[hidden]")).toBeNull());
    expect(screen.getByRole("region", { name: "科研绘图应用" })).toBe(workspace);
    expect((within(workspace).getByRole("textbox", { name: "图形描述" }) as HTMLTextAreaElement).value).toBe("A points to B");
    expect(view.container.querySelector(".app-navigation-shell")).not.toBeNull();
  });

  it("switches the visible workspace when a native editor action arrives and can return to Code", async () => {
    const user = userEvent.setup();
    const view = await readyApp();
    act(() => bridge.action?.({ kind: "select-module", id: "chat" }));
    await waitFor(() => expect(useStore.getState().tab).toBe("chat"));
    await waitFor(() => expect(view.container.querySelector(".app-code-shell")).toBeNull());
    expect(screen.getByText("Chat workspace").closest("[hidden]")).toBeNull();
    expect(screen.getByTitle("Code workbench").closest("[hidden]")).not.toBeNull();
    await user.click(within(view.container.querySelector<HTMLElement>(".app-navigation-rail")!).getByRole("button", { name: "代码" }));
    await waitFor(() => expect(view.container.querySelector(".app-code-shell")).not.toBeNull());
    expect(screen.getByTitle("Code workbench").closest("[hidden]")).toBeNull();
  });

  it("offers a desktop titlebar exit even when the editor bridge is disconnected", async () => {
    const user = userEvent.setup();
    const view = await readyApp();
    const titlebar = view.container.querySelector<HTMLElement>(".window-titlebar")!;
    await user.click(within(titlebar).getByRole("button", { name: "当前功能：Code，点击切换" }));
    await user.click(screen.getByRole("menuitemradio", { name: "对话" }));
    await waitFor(() => expect(useStore.getState().tab).toBe("chat"));
    expect(screen.getByText("Chat workspace").closest("[hidden]")).toBeNull();
    await user.click(within(view.container.querySelector<HTMLElement>(".app-navigation-rail")!).getByRole("button", { name: "代码" }));
    await waitFor(() => expect(view.container.querySelector(".app-code-shell")).not.toBeNull());
    await user.click(within(titlebar).getByRole("button", { name: "当前功能：Code，点击切换" }));
    const menu = screen.getByRole("menu", { name: "SomniQ 功能" });
    act(() => bridge.connection?.(false));
    await waitFor(() => expect(view.container.querySelector(".app-code-shell")).toBeNull());
    expect(screen.getByRole("menu", { name: "SomniQ 功能" })).toBe(menu);
    act(() => bridge.connection?.(true));
    await waitFor(() => expect(view.container.querySelector(".app-code-shell")).not.toBeNull());
    expect(screen.getByRole("menu", { name: "SomniQ 功能" })).toBe(menu);
    await user.click(screen.getByRole("menuitemradio", { name: "设置" }));
    await waitFor(() => expect(useStore.getState().tab).toBe("settings"));
    expect(screen.getByText("Settings workspace").closest("[hidden]")).toBeNull();
  });
});
