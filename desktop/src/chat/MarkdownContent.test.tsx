// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/tauri", () => ({
  fileOpen: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => ({ diagramType: "flowchart-v2" })),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 400 220" role="img"><text>Rendered Mermaid</text></svg>' })),
  },
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

  it("renders Mermaid code blocks as diagrams", async () => {
    render(
      <MarkdownContent text={"```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```"} />,
    );

    expect(await screen.findByTestId("mermaid-diagram")).toBeTruthy();
    expect(screen.getByText("Rendered Mermaid")).toBeTruthy();
    expect(screen.queryByText("flowchart LR")).toBeNull();
  });

  it("renders unlabeled fenced code as a code block", () => {
    const { container } = render(
      <MarkdownContent text={"```\nconst answer = 42;\n```"} />,
    );

    const block = container.querySelector(".md-code-block");
    expect(block).toBeTruthy();
    expect(block?.textContent).toContain("text");
    expect(block?.textContent).toContain("const answer = 42;");
  });

  it("renders inline and display LaTeX formulas", () => {
    const { container } = render(
      <MarkdownContent text={"Inline $E=mc^2$.\n\n$$\\int_0^1 x^2\\,dx$$"} />,
    );

    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).toBeTruthy();
    expect(container.textContent).not.toContain("$E=mc^2$");
  });

  it("renders backslash-delimited LaTeX formulas from model output", () => {
    const { container } = render(
      <MarkdownContent text={"Use \\(a^2+b^2=c^2\\) and then:\n\n\\[x=\\frac{-b}{2a}\\]"} />,
    );

    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).toBeTruthy();
    expect(container.textContent).not.toContain("\\(");
    expect(container.textContent).not.toContain("\\[");
  });

  it("does not render LaTeX delimiters inside fenced code", () => {
    const { container } = render(
      <MarkdownContent text={"```tex\n\\(x+y\\)\n$$z$$\n```"} />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".md-code-block")?.textContent).toContain("\\(x+y\\)");
    expect(container.querySelector(".md-code-block")?.textContent).toContain("$$z$$");
  });

  it("keeps an open streaming think tag inside a bounded thinking block", async () => {
    const { container, rerender } = render(
      <MarkdownContent text={"<think>first step\nsecond step"} streaming />,
    );

    expect(screen.getByText(/正在思考/)).toBeTruthy();
    expect(container.querySelector(".md-think-body")).toBeTruthy();
    expect(container.textContent).not.toContain("<think>");

    rerender(<MarkdownContent text={"<think>first step\nsecond step</think>\n\nDone."} />);

    await screen.findByText(/已/);
    await waitFor(() => expect(container.querySelector(".md-think-body")).toBeNull());
    expect(screen.getByText("Done.")).toBeTruthy();
  });

  it("swallows orphan think closing tags without breaking Markdown", () => {
    const { container } = render(
      <MarkdownContent text={"### 一行结论\n\n</think> **停止判断依赖闭合**\n\n```text\nliteral </think> stays in code\n```"} />,
    );

    expect(container.querySelector("h3")?.textContent).toBe("一行结论");
    expect(container.textContent).toContain("停止判断依赖闭合");
    expect(container.textContent).not.toContain("</think> **停止判断");
    expect(container.querySelector(".md-code-block")?.textContent).toContain("literal </think> stays in code");
  });

  it("falls back to a compact error state when Mermaid syntax is invalid", async () => {
    const { default: mermaid } = await import("mermaid");
    vi.mocked(mermaid.parse).mockRejectedValueOnce(new Error("syntax error"));

    render(
      <MarkdownContent text={"```mermaid\nflowchart LR\n  A -->\n```"} />,
    );

    expect(await screen.findByText("Mermaid syntax error")).toBeTruthy();
    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
    expect(screen.getByText(/The diagram was not rendered/)).toBeTruthy();
  });
});
