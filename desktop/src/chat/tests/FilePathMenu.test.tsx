// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";

const copyImage = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("../../imageClipboard", () => ({ copyImageToClipboard: copyImage }));
vi.mock("../../api/tauri", () => ({ fileOpen: vi.fn(), fileRead: vi.fn(), isTauri: () => false }));
import FilePathMenu from "../FilePathMenu";

const props = {
  x: 80, y: 100,
  path: ".somniq/artifacts/somni-images/result.png",
  onClose: vi.fn(), onAttach: vi.fn(), onOpenInWorkspace: vi.fn(),
};

describe("image file context menu", () => {
  beforeEach(() => {
    useStore.setState({ language: "cn" });
    copyImage.mockResolvedValue(undefined);
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("copies the selected generated image and closes after success", async () => {
    render(<FilePathMenu {...props} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "复制图片" }));
    expect(copyImage).toHaveBeenCalledWith(props.path);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitem", { name: "复制路径" })).toBeTruthy();
  });

  it("prevents duplicate writes and keeps the menu open until copying finishes", async () => {
    let finish!: () => void;
    copyImage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<FilePathMenu {...props} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "复制图片" }));
    const pending = screen.getByRole("menuitem", { name: "正在复制图片…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(pending);
    expect(copyImage).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it("shows a failure and lets the user retry", async () => {
    copyImage.mockRejectedValueOnce(new Error("Clipboard busy"));
    render(<FilePathMenu {...props} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "复制图片" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "图片复制失败，请重试。");
    expect(props.onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitem", { name: "复制图片" }));
    expect(copyImage).toHaveBeenCalledTimes(2);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("supports English and previews whose uploaded image has a misleading extension", () => {
    useStore.setState({ language: "en" });
    render(<FilePathMenu {...props} path="uploads/screenshot.png.pdf" image />);
    expect(screen.getByRole("menuitem", { name: "Copy image" })).toBeTruthy();
  });

  it("does not offer image copying for a document", () => {
    render(<FilePathMenu {...props} path="notes/report.pdf" />);
    expect(screen.queryByRole("menuitem", { name: "复制图片" })).toBeNull();
  });
});
