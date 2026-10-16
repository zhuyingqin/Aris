// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  fileAssetUrl: vi.fn<(...args: string[]) => Promise<string>>(),
  fileReadBytes: vi.fn<(...args: string[]) => Promise<ArrayBuffer>>(),
  fileOpen: vi.fn(),
  fileReveal: vi.fn(),
}));
vi.mock("../../api/tauri", () => apiMocks);

import { useStore } from "../../store";
import ChatImageReference from "../ChatImageReference";

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.isTauri.mockReturnValue(true);
  apiMocks.fileAssetUrl.mockResolvedValue("asset://figure.png");
  apiMocks.fileReadBytes.mockResolvedValue(new ArrayBuffer(4));
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:figure") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  useStore.setState({ language: "en", tab: "chat", pendingTypesetFilePath: null,
    pendingSidePanelFilePath: null,
    currentProject: { id: "p1", name: "work", path: "F:/work", addedAt: 0, lastOpenedAt: 0 } });
});
afterEach(cleanup);

describe("ChatImageReference", () => {
  it("opens the picture on demand with zoom controls and keeps the conversation active", async () => {
    let finish!: (url: string) => void;
    apiMocks.fileAssetUrl.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<ChatImageReference src="figures/scene%20one.PNG" label="Scene" />);
    const reference = screen.getByRole("button", { name: "View image · Scene" });
    expect(apiMocks.fileAssetUrl).not.toHaveBeenCalled();
    expect(apiMocks.fileReadBytes).not.toHaveBeenCalled();

    await user.click(reference);
    const viewer = screen.getByRole("dialog", { name: "scene one.PNG" });
    expect(within(viewer).getByRole("status").textContent).toBe("Loading image…");
    expect(apiMocks.fileAssetUrl).toHaveBeenCalledWith("F:/work/figures/scene one.PNG", "image/png");
    await act(async () => { finish("asset://figure.png"); });
    expect(within(viewer).getByRole("img", { name: "Scene" }).getAttribute("src")).toBe("asset://figure.png");
    await user.click(within(viewer).getByRole("button", { name: "Zoom in" }));
    const fit = within(viewer).getByRole("button", { name: "Fit to window" });
    expect(fit.getAttribute("aria-pressed")).toBe("false");
    await user.click(fit);
    expect(fit.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(reference);
    expect(useStore.getState().tab).toBe("chat");
    expect(useStore.getState().pendingTypesetFilePath).toBeNull();
    expect(useStore.getState().pendingSidePanelFilePath).toBeNull();
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("keeps a failed read in the image viewer with an explicit close action", async () => {
    apiMocks.fileAssetUrl.mockRejectedValueOnce(new Error("missing file"));
    render(<ChatImageReference src="figures/missing.svg" />);
    await userEvent.click(screen.getByRole("button", { name: "View image · missing.svg" }));
    const viewer = screen.getByRole("dialog", { name: "missing.svg" });
    expect(await within(viewer).findByText("This image cannot be displayed.")).toBeTruthy();
    expect(apiMocks.fileAssetUrl).toHaveBeenCalledWith("F:/work/figures/missing.svg", "image/svg+xml");
    expect(useStore.getState().tab).toBe("chat");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
    await userEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("releases a browser image that finishes loading after the viewer closes", async () => {
    apiMocks.isTauri.mockReturnValue(false);
    let finish!: (bytes: ArrayBuffer) => void;
    apiMocks.fileReadBytes.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<ChatImageReference src="figures/slow.png" />);
    await userEvent.click(screen.getByRole("button", { name: "View image · slow.png" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await act(async () => { finish(new ArrayBuffer(4)); });
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:figure"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiMocks.fileAssetUrl).not.toHaveBeenCalled();
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });
});
