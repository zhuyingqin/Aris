// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TypesetAiPanel from "../TypesetAiPanel";
import { useStore } from "../../store";

vi.mock("../../chat/Chat", () => ({
  default: function MockChat(props: { embedded?: boolean }) {
    return (
      <div data-testid="mock-chat" data-embedded={props.embedded ? "true" : "false"}>
        Mock Chat
      </div>
    );
  },
}));

describe("TypesetAiPanel", () => {
  beforeEach(() => {
    useStore.setState({ tab: "typeset" });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render when the active tab is not typeset", () => {
    useStore.setState({ tab: "chat" });
    const { container } = render(<TypesetAiPanel />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("mock-chat")).toBeNull();
  });

  it("renders an embedded Chat instance when tab is typeset", () => {
    useStore.setState({ tab: "typeset" });
    render(<TypesetAiPanel />);
    const chat = screen.getByTestId("mock-chat");
    expect(chat).toBeTruthy();
    expect(chat.getAttribute("data-embedded")).toBe("true");
    expect(screen.getByRole("region", { name: "AI assistant" })).toBeTruthy();
  });
});
