// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyImage = vi.hoisted(() => vi.fn<(...args: string[]) => Promise<void>>());
vi.mock("./imageClipboard", () => ({ copyImageToClipboard: copyImage }));
vi.mock("./api/tauri", () => ({ isTauri: () => true, fileOpen: vi.fn(), fileReveal: vi.fn() }));
import ImageLightbox from "./ImageLightbox";
import { useStore } from "./store";

const props = { src: "blob:displayed-image", title: "Result", onClose: vi.fn() };

beforeEach(() => {
  useStore.setState({ language: "en" });
  copyImage.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("image viewer actions", () => {
  it("copies a pathless image with a visible success result", async () => {
    render(<ImageLightbox {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy image" }));
    expect(copyImage).toHaveBeenCalledWith("blob:displayed-image", "blob:displayed-image");
    expect(screen.getByRole("status").textContent).toBe("Image copied");
    expect(screen.getByRole("button", { name: "Copy image" }).title).toBe("Image copied");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("copies the original local file with the displayed source available as a fallback", async () => {
    render(<ImageLightbox {...props} path="F:/研究/图.png" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy image" }));
    expect(copyImage).toHaveBeenCalledWith("F:/研究/图.png", "blob:displayed-image");
  });

  it("disables repeated writes until the clipboard operation completes", async () => {
    let finish!: () => void;
    copyImage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<ImageLightbox {...props} />);
    const button = screen.getByRole("button", { name: "Copy image" });
    await userEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.title).toBe("Copying image…");
    await userEvent.click(button);
    expect(copyImage).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a clipboard failure and allows another attempt", async () => {
    copyImage.mockRejectedValueOnce(new Error("Clipboard busy"));
    render(<ImageLightbox {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy image" }));
    expect(screen.getByRole("alert").textContent).toBe("Could not copy image. Try again.");
    await userEvent.click(screen.getByRole("button", { name: "Copy image" }));
    expect(copyImage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Image copied");
  });

  it("does not report copying a path as successful when clipboard writing fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard denied"));
    render(<ImageLightbox {...props} path="figures/plot.png" />);
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(screen.getByRole("alert").textContent).toBe("Could not copy path. Try again.");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])("copies with the platform copy shortcut: %o", async (modifier) => {
    render(<ImageLightbox {...props} />);
    fireEvent.keyDown(document, { key: "c", ...modifier });
    await waitFor(() => expect(copyImage).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("status")).textContent).toBe("Image copied");
  });

  it("lets selected path text use the normal copy shortcut", () => {
    render(<ImageLightbox {...props} path="figures/plot.png" />);
    const pathText = screen.getByText("figures/plot.png");
    const range = document.createRange();
    range.selectNodeContents(pathText);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("figures/plot.png");
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(copyImage).not.toHaveBeenCalled();
  });

  it("retries a decode failure in the current viewer", async () => {
    render(<ImageLightbox {...props} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("alert").textContent).toContain("This image cannot be displayed.");
    expect((screen.getByRole("button", { name: "Copy image" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Reload image" }));
    expect(screen.getByRole("img").getAttribute("src")).toBe(props.src);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks the file loader to retry a failed read", async () => {
    const onRetry = vi.fn();
    render(<ImageLightbox {...props} src={null} loadError onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Reload image" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("recovers when a new image replaces a failed image", () => {
    const view = render(<ImageLightbox {...props} />);
    fireEvent.error(screen.getByRole("img"));
    view.rerender(<ImageLightbox {...props} src="blob:new-image" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:new-image");
  });

  it("toggles between natural size and fit on double-click", () => {
    render(<ImageLightbox {...props} />);
    const image = screen.getByRole("img");
    Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } });
    fireEvent.load(image);
    fireEvent.doubleClick(image);
    expect(image.style.width).toBe("1600px");
    expect(screen.getByRole("button", { name: "Fit to window" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.doubleClick(image);
    expect(image.style.width).toBe("");
    expect(screen.getByRole("button", { name: "Fit to window" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("uses Chinese labels for viewer image actions", async () => {
    useStore.setState({ language: "cn" });
    render(<ImageLightbox {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "复制图片" }));
    expect(screen.getByRole("status").textContent).toBe("图片已复制");
  });
});
