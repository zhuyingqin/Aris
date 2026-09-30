// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BarChart, FlowDiagram } from "../paperReadingApi";
import { layeredGuideFixture } from "./paperGuideFixture";

const renderMermaid = vi.fn();
vi.mock("../../chat/MermaidDiagram", () => ({ renderMermaid: (code: string, theme: string) => renderMermaid(code, theme) }));
vi.mock("../../pdf/canvas", () => ({ renderPdfPageToCanvas: () => ({ task: { promise: Promise.resolve(), cancel: vi.fn() } }) }));
import PaperGuideDiagram, { diagramMarkdown, flowToMermaid } from "../PaperGuideDiagram";
import PaperGuideView from "../PaperGuideView";

afterEach(() => {
  cleanup();
  renderMermaid.mockReset();
});

const flow = (): FlowDiagram => ({
  kind: "flow", title: "Scaled attention", direction: "TD",
  nodes: [
    { id: "end", label: "Queries $Q$", role: "input" },
    { id: "score", label: 'Score "raw" <script>alert(1)</script> #1 | `code`' },
    { id: "out", label: "Output", role: "output" },
  ],
  edges: [{ from: "end", to: "score", label: "Q·K^T" }, { from: "score", to: "out" }],
  groups: [{ label: "Attention block", nodes: ["score"] }],
  caption: "Scaling happens before softmax.",
});

const bars = (origin: BarChart["origin"]): BarChart => ({
  kind: "bars", title: "BLEU on the test set", unit: "BLEU", origin,
  bars: [{ label: "Baseline", value: 20 }, { label: "This paper", value: 40, highlight: true }],
  caption: "Same metric and split.",
});

describe("teaching diagrams", () => {
  it("turns a validated flow into Mermaid text that no label can escape", () => {
    const code = flowToMermaid(flow());
    expect(code.split("\n")[0]).toBe("flowchart TD");
    expect(code).toContain('n0("Queries Q")');
    expect(code).not.toMatch(/\bend\[|\bend\(/);
    expect(code).toContain('subgraph g0["Attention block"]');
    expect(code).toContain('n1["Score #quot;raw#quot; #lt;script#gt;alert(1)#lt;/script#gt; #35;1 #124; #96;code#96;"]');
    expect(code).toContain('n0 -->|"Q·K^T"| n1');
    expect(code).toContain("n1 --> n2");
    expect(code).not.toMatch(/<script|`|"raw"/);
  });

  it("draws the flow with the app theme and falls back to text when drawing fails", async () => {
    renderMermaid.mockResolvedValueOnce('<svg data-testid="drawn" viewBox="0 0 1000 200"></svg>');
    const { container, unmount } = render(<PaperGuideDiagram diagram={flow()} english eyebrow="See it in a picture" />);
    await waitFor(() => expect(container.querySelector('[data-testid="drawn"]')).toBeTruthy());
    // A wide flow shrinks only so far, then scrolls, so labels stay readable.
    expect(container.querySelector<HTMLElement>(".paper-essay-diagram-stage")!.style.minWidth).toBe("850px");
    expect(renderMermaid).toHaveBeenCalledWith(flowToMermaid(flow()), expect.any(String));
    expect(screen.getByText("Scaled attention")).toBeTruthy();
    expect(screen.getByText(/not an original figure/)).toBeTruthy();
    unmount();

    renderMermaid.mockRejectedValueOnce(new Error("syntax"));
    render(<PaperGuideDiagram diagram={flow()} english={false} eyebrow="看图理解" />);
    const fallback = await screen.findByRole("list", { name: "示意图（文字版）" });
    expect(fallback.textContent).toContain("Queries $Q$ → Q·K^T → Score");
    expect(screen.getByText("讲解示意图：根据原文整理，不是论文原图")).toBeTruthy();
  });

  it("compares numbers on one scale and says where they come from", () => {
    const { container, rerender } = render(<PaperGuideDiagram diagram={bars("paper")} english={false} eyebrow="看图理解" />);
    const fills = [...container.querySelectorAll<HTMLElement>(".paper-essay-bar-fill")].map(fill => fill.style.width);
    expect(fills).toEqual(["50%", "100%"]);
    expect(container.querySelector(".is-highlight")?.textContent).toContain("40 BLEU");
    expect(screen.getByText("数值来自论文原始表格")).toBeTruthy();
    rerender(<PaperGuideDiagram diagram={bars("teaching")} english={false} eyebrow="看图理解" />);
    expect(screen.getByText("教学构造的数据，不是论文结果")).toBeTruthy();
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(diagramMarkdown(bars("paper"))).toContain("| This paper | 40 |");
    expect(diagramMarkdown(flow())).toContain("```mermaid\nflowchart TD");
  });

  it("shows the overview picture and each lesson's picture after its intuition", async () => {
    renderMermaid.mockResolvedValue("<svg></svg>");
    const guide = layeredGuideFixture();
    guide.outline.result!.diagram = { ...flow(), title: "The paper at a glance" };
    guide.lessons[0].task.result!.diagram = bars("teaching");
    const onSaveNote = vi.fn();
    const { container } = render(<PaperGuideView guide={guide} document={null} onJump={vi.fn()} language="zh" onSaveNote={onSaveNote} />);
    expect(screen.getByText("一图看懂论文")).toBeTruthy();
    expect(screen.getByText("The paper at a glance")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /什么是注意力/ })[0]);
    const intuition = container.querySelector(".paper-essay-intuition")!;
    expect(intuition.nextElementSibling?.classList.contains("paper-essay-diagram")).toBe(true);
    expect(screen.getByText("看图理解")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存到笔记" }));
    expect(onSaveNote.mock.calls[0][0].content).toContain("## 看图理解");
  });
});
