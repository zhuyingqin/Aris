// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PaperReadingContent from "../PaperReadingContent";

afterEach(cleanup);

describe("paper reading transcriptions", () => {
  it("keeps blank table cells attached to their column headers", () => {
    render(<PaperReadingContent content={"| Row | h | d_k | BLEU |\n|---|---|---|---|\n| base | 8 | 64 | 25.8 |\n| B | | 16 | 25.1 |"} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[0]).getAllByRole("columnheader").map(cell => cell.textContent))
      .toEqual(["Row", "h", "d_k", "BLEU"]);
    expect(within(rows[2]).getAllByRole("cell").map(cell => cell.textContent))
      .toEqual(["B", "", "16", "25.1"]);
  });

  it("renders grouped formula notation with accessible MathML", () => {
    const { container } = render(<PaperReadingContent content={String.raw`$$\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\left(\frac{QK^{T}}{\sqrt{d_{k}}}\right)V \tag{1}$$`} />);
    expect(container.querySelector("math mfrac msqrt msub")?.textContent).toBe("dk");
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.querySelector("annotation")?.textContent).toContain(String.raw`\sqrt{d_{k}}`);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("does not load remote images or activate model-authored HTML", () => {
    const { container } = render(<PaperReadingContent content={'![Figure](https://example.com/tracker.png)\n\n<img src="https://example.com/other.png" onerror="alert(1)" />'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Figure")).toBeTruthy();
  });
  it("renders display equations between paragraphs without rewriting code examples", () => {
    const text = "Before.\n\n$$x = 1$$\n\nAfter.\n\n```latex\n$$y = 2$$\n```";
    const { container } = render(<PaperReadingContent content={text} />);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(container.querySelector("pre code")?.textContent).toBe("$$y = 2$$\n");
    expect(screen.getByText("Before.")).toBeTruthy();
    expect(screen.getByText("After.")).toBeTruthy();
  });

});
