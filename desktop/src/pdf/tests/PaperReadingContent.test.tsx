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

  it("breaks legacy dense guide prose into readable paragraphs without breaking structured Markdown", () => {
    const dense = String.raw`理论证据：定理说明 $S^j$ 在指定条件下收敛，并给出了相应的边界。下一个定理再用 Lyapunov 函数说明迭代为什么保持稳定。在激励条件成立时，权重误差也会收敛。数值证据：仿真对照了专家策略与学习策略，并报告了权重收敛情况。离线实验给出了收敛矩阵，在线实验则加入了探索噪声。图表还展示了学习输入如何跟随专家。因此实验支持算法在该设置下可以跟随专家，但不代表对任意系统都有同样的保证。`;
    const structured = `${dense}\n\n- 保留列表\n\n| 组别 | 结果 |\n|---|---|\n| 在线 | 收敛 |\n\n\`\`\`text\nA. B.\n\`\`\``;
    const { container } = render(<PaperReadingContent content={structured} readableProse />);
    expect(container.querySelectorAll("p").length).toBeGreaterThan(1);
    expect(container.querySelector("math")).not.toBeNull();
    expect(container.querySelector("annotation")?.textContent).toBe("S^j");
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).toContain("理论证据：");
    expect(container.textContent).toContain("数值证据：");
    expect(screen.getByRole("listitem").textContent).toBe("保留列表");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(container.querySelector("pre code")?.textContent).toBe("A. B.\n");
  });

});
