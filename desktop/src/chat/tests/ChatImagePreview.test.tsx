// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fileOpen: vi.fn(() => Promise.resolve()),
  fileReadBytes: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
  fileAssetUrl: vi.fn(() => Promise.resolve("asset://staged.png")),
  isTauri: vi.fn(() => true),
}));

vi.mock("../../api/tauri", () => apiMocks);

import ChatImagePreview from "../ChatImagePreview";

describe("ChatImagePreview", () => {
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
    expect(apiMocks.fileAssetUrl).toHaveBeenCalledWith(
      ".somniq/uploads/1789175029662810100-0-screenshot.png.pdf",
      "image/png",
    );
  });

  it("still ignores a non-image source with no declared type", () => {
    const { container } = render(<ChatImagePreview src="notes/report.pdf" alt="Report" />);
    expect(container.innerHTML).toBe("");
    expect(apiMocks.fileAssetUrl).not.toHaveBeenCalled();
  });
});
