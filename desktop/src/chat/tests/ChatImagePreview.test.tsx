// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fileOpen: vi.fn(() => Promise.resolve()),
  fileReveal: vi.fn(() => Promise.resolve()),
  fileReadBytes: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
  fileAssetUrl: vi.fn(() => Promise.resolve("asset://staged.png")),
  isTauri: vi.fn(() => true),
}));

vi.mock("../../api/tauri", () => apiMocks);

import ChatImagePreview, { isPreviewableImagePath } from "../ChatImagePreview";
import { useStore } from "../../store";

describe("ChatImagePreview", () => {
  beforeEach(() => {
    useStore.setState({ language: "en" });
    apiMocks.fileAssetUrl.mockResolvedValue("asset://staged.png");
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("supports an in-app preview action without trying to open an undefined file path", async () => {
    const onClick = vi.fn();
    render(
      <ChatImagePreview
        src="data:image/png;base64,iVBORw0KGgo="
        alt="Generated image"
        title="Enlarge image"
        onClick={onClick}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Generated image/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("renders a declared image whose staged path has a misleading extension", async () => {
    // Uploads staged before the naming fix landed as `<name>.png.pdf`, so the
    // extension alone says "PDF" for a file the composer knows is an image.
    render(
      <ChatImagePreview
        src=".somniq/uploads/1789175029662810100-0-screenshot.png.pdf"
        alt="Pasted screenshot"
        mimeType="image/png"
      />,
    );
    const image = await screen.findByAltText("Pasted screenshot");
    expect(image.getAttribute("src")).toBe("asset://staged.png");
    expect(image.getAttribute("data-image-path")).toBe(".somniq/uploads/1789175029662810100-0-screenshot.png.pdf");
    expect(apiMocks.fileAssetUrl).toHaveBeenCalledWith(
      ".somniq/uploads/1789175029662810100-0-screenshot.png.pdf",
      "image/png",
    );
  });

  it("opens a local image in SomniQ's own viewer instead of the system image app", async () => {
    render(
      <ChatImagePreview
        src="figures/plot.png"
        alt="Result plot"
        title="figures/plot.png"
        openPath="F:/project/figures/plot.png"
      />,
    );
    const preview = await screen.findByAltText("Result plot");
    expect(preview.getAttribute("data-image-path")).toBe("F:/project/figures/plot.png");
    await userEvent.click(screen.getByRole("button", { name: /Result plot/ }));

    const viewer = await screen.findByRole("dialog", { name: "plot.png" });
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
    expect(within(viewer).getByAltText("Result plot").getAttribute("data-image-path"))
      .toBe("F:/project/figures/plot.png");

    // The system image app stays reachable, but only as an explicit action.
    await userEvent.click(within(viewer).getByRole("button", { name: "Open with system app" }));
    expect(apiMocks.fileOpen).toHaveBeenCalledWith("F:/project/figures/plot.png");
  });

  it("closes the in-app viewer with Escape", async () => {
    render(
      <ChatImagePreview
        src="figures/plot.png"
        alt="Result plot"
        openPath="F:/project/figures/plot.png"
      />,
    );
    await screen.findByAltText("Result plot");
    await userEvent.click(screen.getByRole("button", { name: /Result plot/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still ignores a non-image source with no declared type", () => {
    const { container } = render(<ChatImagePreview src="notes/report.pdf" alt="Report" />);
    expect(container.innerHTML).toBe("");
    expect(apiMocks.fileAssetUrl).not.toHaveBeenCalled();
  });
});


describe("complete image opening", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it.each([
    "https://example.com/image.png?token=a%2Fb%2520c",
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
    "blob:pasted-image",
  ])("opens pathless images in the viewer without rewriting their source: %s", async (src) => {
    useStore.setState({ language: "en" });
    render(<ChatImagePreview src={src} alt="Image without file" />);
    expect(screen.getByAltText("Image without file").getAttribute("src")).toBe(src);
    await userEvent.click(screen.getByRole("button", { name: "Image without file" }));
    const viewer = screen.getByRole("dialog");
    expect(within(viewer).getByRole("img").getAttribute("src")).toBe(src);
    expect(within(viewer).queryByRole("button", { name: "Copy path" })).toBeNull();
    expect(apiMocks.fileReadBytes).not.toHaveBeenCalled();
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a local image even when its caller did not pass an explicit openPath", async () => {
    render(<ChatImagePreview src="图表/设计 稿.avif" alt="Local image" />);
    await screen.findByAltText("Local image");
    await userEvent.click(screen.getByRole("button", { name: "Local image" }));
    expect(screen.getByRole("dialog", { name: "设计 稿.avif" })).toBeTruthy();
    expect(apiMocks.fileAssetUrl).toHaveBeenCalledWith("图表/设计 稿.avif", "image/avif");
  });

  it("keeps images inside a custom gallery non-interactive when requested", async () => {
    const onClick = vi.fn();
    render(<ChatImagePreview src="data:image/png;base64,iVBORw0KGgo=" alt="Gallery image" interactive={false} onClick={onClick} />);
    await userEvent.click(screen.getByAltText("Gallery image"));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retries a failed local read inside the viewer without launching another application", async () => {
    useStore.setState({ language: "en" });
    apiMocks.fileAssetUrl.mockRejectedValueOnce(new Error("File not ready"));
    render(<ChatImagePreview src="figures/late.png" alt="Late image" />);
    await userEvent.click(await screen.findByRole("button", { name: /Could not load image/ }));
    const viewer = screen.getByRole("dialog");
    expect(within(viewer).getByRole("alert").textContent).toContain("This image cannot be displayed.");
    await userEvent.click(within(viewer).getByRole("button", { name: "Reload image" }));
    expect(await within(viewer).findByRole("img", { name: "Late image" })).toBeTruthy();
    expect(apiMocks.fileAssetUrl).toHaveBeenCalledTimes(2);
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("retries a decoded preview failure in place", async () => {
    useStore.setState({ language: "en" });
    render(<ChatImagePreview src="https://example.com/retry.png" alt="Retry image" />);
    fireEvent.error(screen.getByRole("img"));
    await userEvent.click(screen.getByRole("button", { name: /Could not load image/ }));
    const viewer = screen.getByRole("dialog");
    await userEvent.click(within(viewer).getByRole("button", { name: "Reload image" }));
    expect(within(viewer).getByRole("img").getAttribute("src")).toBe("https://example.com/retry.png");
  });

  it("releases a late blob response when the preview has already unmounted", async () => {
    let finish!: (url: string) => void;
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    apiMocks.fileAssetUrl.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<ChatImagePreview src="figures/slow.png" alt="Slow image" />);
    view.unmount();
    await act(async () => { finish("blob:late-image"); });
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:late-image"));
  });

  it.each([
    "/home/user/figures/plot.png", "图表/示意图.webp", "file:///F:/论文/图.svg",
    "F:\\研究\\图.png", "\\\\server\\project\\plot.png", "figures/result.avif",
  ])("recognizes local image paths across supported platforms: %s", (path) => {
    expect(isPreviewableImagePath(path)).toBe(true);
  });

  it.each(["example.com/plot.png", "notes/report.pdf", "javascript:plot.png"])("does not classify another resource as a local image: %s", (path) => {
    expect(isPreviewableImagePath(path)).toBe(false);
  });
});
