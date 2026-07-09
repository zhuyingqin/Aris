// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCommandSelection } from "../../types";
import CommandSelection from "../CommandSelection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CommandSelection", () => {
  const selection: ChatCommandSelection = {
    command: "model",
    title: "Select executor model",
    subtitle: "Provider: anthropic",
    current: "claude-opus-4-7",
    items: [
      {
        value: "claude-opus-4-7",
        label: "claude-opus-4-7",
        description: "Current model",
        isCurrent: true,
      },
      {
        value: "claude-sonnet-4-6",
        label: "claude-sonnet-4-6",
        description: "Everyday model",
        isCurrent: false,
      },
    ],
  };

  it("selects an option with keyboard navigation and keeps the active item in view", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <CommandSelection
        selection={selection}
        bottomOffset={120}
        onSelect={onSelect}
        onCancel={() => undefined}
      />,
    );

    const listbox = screen.getByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(document.activeElement).toBe(listbox);
    expect(listbox.getAttribute("aria-activedescendant")).toContain("option-1");
    expect(scrollIntoView).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("claude-sonnet-4-6");
  });
});
