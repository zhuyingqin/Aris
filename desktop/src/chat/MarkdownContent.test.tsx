// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/tauri", () => ({
  fileOpen: vi.fn(),
}));

import MarkdownContent from "./MarkdownContent";
import { useStore } from "../store";

beforeEach(() => {
  useStore.setState({
    tab: "chat",
    pendingStudioArtifactId: null,
  });
});

afterEach(() => cleanup());

describe("MarkdownContent Studio links", () => {
  it("switches to Studio and selects the linked artifact", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownContent text="[Open result](studio/artifact/web%3Airl-demo)" />,
    );

    await user.click(screen.getByRole("link", { name: "Open result" }));

    expect(useStore.getState().tab).toBe("studio");
    expect(useStore.getState().pendingStudioArtifactId).toBe("web:irl-demo");
  });

  it("uses a lightweight preview for very large Markdown messages", () => {
    render(<MarkdownContent text={"x".repeat(90_000)} />);

    expect(screen.getByText("Large response preview")).toBeTruthy();
    expect(screen.getByText(/characters are hidden here/)).toBeTruthy();
  });
});
