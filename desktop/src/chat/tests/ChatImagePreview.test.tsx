// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fileOpen: vi.fn(() => Promise.resolve()),
  fileReadBytes: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
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
});
