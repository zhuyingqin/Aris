// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTauri, screenshotShortcutSet, screenshotShortcutStatus } from "../api/tauri";
import ScreenshotShortcutSettings from "./ScreenshotShortcutSettings";

vi.mock("../api/tauri", () => ({
  isTauri: vi.fn(() => true), screenshotShortcutSet: vi.fn(), screenshotShortcutStatus: vi.fn(),
}));
const original = { shortcut: "CmdOrCtrl+Shift+A", registered: true, error: null };
beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(screenshotShortcutStatus).mockResolvedValue(original);
  vi.mocked(screenshotShortcutSet).mockImplementation(async (shortcut) => ({ shortcut, registered: true, error: null }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function edit() {
  render(<ScreenshotShortcutSettings language="cn" />);
  const button = screen.getByRole("button", { name: "修改截图快捷键" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  return button;
}

it("records a global combination, waits for registration, and removes Try it", async () => {
  const button = await edit();
  expect(screen.queryByText("试一下")).toBeNull();
  fireEvent.keyDown(button, { key: "b", code: "KeyB", ctrlKey: true, shiftKey: true });
  expect(screenshotShortcutSet).toHaveBeenCalledWith("Ctrl+Shift+KeyB");
  await screen.findByText("已保存");
  expect(button.textContent).toBe("Ctrl + Shift + B");
});

it("Escape, Tab, and blur cancel without registering", async () => {
  const button = await edit();
  fireEvent.keyDown(button, { key: "Escape", code: "Escape" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: "Tab", code: "Tab" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  fireEvent.blur(button);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(screenshotShortcutSet).not.toHaveBeenCalled();
});

it("ignores modifier presses and rejects plain typing without changing the shortcut", async () => {
  const button = await edit();
  fireEvent.keyDown(button, { key: "Control", code: "ControlLeft", ctrlKey: true });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.keyDown(button, { key: "b", code: "KeyB" });
  expect(screen.getByRole("alert").textContent).toContain("修饰键");
  expect(screenshotShortcutSet).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(button.textContent).toBe("Ctrl + Shift + A");
});

it("keeps the actual shortcut on registration failure and retries the requested combination", async () => {
  vi.mocked(screenshotShortcutSet).mockRejectedValueOnce(new Error("Shortcut already occupied"));
  const button = await edit();
  fireEvent.keyDown(button, { key: "b", code: "KeyB", altKey: true });
  await screen.findByRole("alert");
  expect(button.textContent).toBe("Ctrl + Shift + A");
  expect(screen.queryByText("已保存")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("已保存");
  expect(button.textContent).toBe("Alt + B");
  expect(screenshotShortcutSet).toHaveBeenLastCalledWith("Alt+KeyB");
});

it("disables editing during save and reflects the backend state if rollback fails", async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(screenshotShortcutSet).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  const button = await edit();
  fireEvent.keyDown(button, { key: "b", code: "KeyB", ctrlKey: true });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(screenshotShortcutStatus).mockResolvedValue({ shortcut: "Ctrl+KeyB", registered: true, error: "Write failed" });
  reject(new Error("Write failed; replacement remains active"));
  await screen.findByRole("alert");
  expect(button.textContent).toBe("Ctrl + B");
  expect(screen.queryByText("已保存")).toBeNull();
});

it("uses an English recording label and disables editing in browser preview", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  render(<ScreenshotShortcutSettings language="en" />);
  expect((screen.getByRole("button", { name: "Edit screenshot shortcut" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("Try it")).toBeNull();
  expect(screenshotShortcutStatus).not.toHaveBeenCalled();
});
