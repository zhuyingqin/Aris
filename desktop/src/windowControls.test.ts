// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import DesktopWindowCloseControl from "./DesktopWindowCloseControl";
import { requestWindowAction } from "./windowControls";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  getCurrentWindow: vi.fn(),
}));

vi.mock("./api/tauri", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: mocks.getCurrentWindow }));

describe("window controls", () => {
  const nativeWindow = {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    mocks.isTauri.mockReset();
    mocks.getCurrentWindow.mockReset();
    nativeWindow.minimize.mockReset();
    nativeWindow.toggleMaximize.mockReset();
    nativeWindow.close.mockReset();
    mocks.getCurrentWindow.mockReturnValue(nativeWindow);
  });

  afterEach(cleanup);

  it("does not request native controls in a browser preview", () => {
    mocks.isTauri.mockReturnValue(false);

    requestWindowAction("close");

    expect(mocks.getCurrentWindow).not.toHaveBeenCalled();
  });

  it("closes the Tauri window", () => {
    mocks.isTauri.mockReturnValue(true);

    requestWindowAction("close");

    expect(nativeWindow.close).toHaveBeenCalledOnce();
  });

  it("renders a close control on a frameless pre-workspace screen", () => {
    mocks.isTauri.mockReturnValue(true);

    render(createElement(DesktopWindowCloseControl));
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));

    expect(nativeWindow.close).toHaveBeenCalledOnce();
  });
});
