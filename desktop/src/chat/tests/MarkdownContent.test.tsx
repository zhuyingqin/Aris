// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fileOpen: vi.fn(),
  codeBridgeOpenFile: vi.fn(),
  fileReadBytes: vi.fn(() => Promise.resolve([137, 80, 78, 71])),
  isTauri: vi.fn(() => false),
}));

vi.mock("../../api/tauri", () => apiMocks);

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => ({ diagramType: "flowchart-v2" })),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 400 220" role="img"><text>Rendered Mermaid</text></svg>' })),
  },
}));

import MarkdownContent from "../MarkdownContent";
import { extractSvgMetrics, mermaidThemeVariables } from "../MermaidDiagram";
import { useStore } from "../../store";

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.fileOpen.mockResolvedValue(undefined);
  apiMocks.codeBridgeOpenFile.mockResolvedValue(undefined);
  apiMocks.fileReadBytes.mockResolvedValue([137, 80, 78, 71]);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:mock-image"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  useStore.setState({
    tab: "chat",
    pendingTypesetFilePath: null,
    pendingSidePanelEvidence: null,
  });
});

afterEach(() => cleanup());

describe("MarkdownContent", () => {
  it("uses a light Mermaid palette when the app is in Light mode", () => {
    expect(mermaidThemeVariables("light")).toMatchObject({
      background: "#f8fafc",
      primaryColor: "#ffffff",
      primaryTextColor: "#1f2937",
      lineColor: "#62758a",
    });
    expect(mermaidThemeVariables("dark")).toMatchObject({
      primaryColor: "#162233",
      primaryTextColor: "#e5edf7",
    });
  });

  it("preserves every Mermaid foreignObject label when the SVG contains HTML line breaks", () => {
    const source = [
      '<svg viewBox="0 0 1010 326" style="max-width: 1010px" xmlns="http://www.w3.org/2000/svg">',
      '<g class="node" id="node-a"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>§2.1 SOTA<br>任务定义·架构前沿</p></div></foreignObject></g>',
      '<g class="node" id="node-b"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>§2.2 工具层<br>稳定性·Conceptor</p></div></foreignObject></g>',
      "</svg>",
    ].join("");

    const result = extractSvgMetrics(source);

    expect(result.width).toBe(1010);
    expect(result.height).toBe(326);
    expect(result.svg).toContain('id="node-a"');
    expect(result.svg).toContain('id="node-b"');
    expect(result.svg).toContain("任务定义·架构前沿");
    expect(result.svg).toContain("稳定性·Conceptor");
    expect(result.svg).not.toContain("max-width");
  });

  it("uses a lightweight preview for very large Markdown messages", () => {
    render(<MarkdownContent text={"x".repeat(90_000)} />);

    expect(screen.getByText("Large response preview")).toBeTruthy();
    expect(screen.getByText(/characters are hidden here/)).toBeTruthy();
  });

  it("renders Markdown data URL images inline", () => {
    render(<MarkdownContent text="![plot](data:image/png;base64,ZmFrZQ==)" />);

    const image = screen.getByRole("img", { name: "plot" }) as HTMLImageElement;
    expect(image.src).toContain("data:image/png;base64,ZmFrZQ==");
    expect(apiMocks.fileReadBytes).not.toHaveBeenCalled();
  });

  it("reads local Markdown image files as blob previews", async () => {
    render(<MarkdownContent text="![plot](results/plot.png)" />);

    const image = await screen.findByRole("img", { name: "plot" }) as HTMLImageElement;

    expect(apiMocks.fileReadBytes).toHaveBeenCalledWith("results/plot.png");
    expect(image.src).toBe("blob:mock-image");
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

  it("splits dense explanatory prose into readable paragraphs", () => {
    const dense = [
      "### Time-LLM 是怎么做的",
      "",
      "Time-LLM 把时间序列预测重新表达为另一个语言任务，先把每条通道归一化，再切成多个重叠 patch，并用一个线性层投到语言模型隐藏维度，让冻结的语言模型可以处理这些片段。第一步是 Patching，把 RevIN 后的序列切成 patch，再投影到模型维度。第二步是 Patch Reprogramming，用一组可学习的 text prototype 和 cross-attention 让每个 patch 组合出时序提示。第三步是 Prompt-as-Prefix，把 dataset context、task instruction 和统计量拼到序列前面，送入冻结 LLM。最后只训练 patch embedder、reprogram cross-attention 和 output projection，LLM 主体保持冻结。这样做的好处是复用语言模型的表征能力，同时避免全量微调带来的成本。",
    ].join("\n");

    const { container } = render(<MarkdownContent text={dense} />);

    expect(container.querySelectorAll(".md-content p").length).toBeGreaterThan(1);
    expect(container.querySelector("h3")?.textContent).toBe("Time-LLM 是怎么做的");
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

  it("wraps standalone display-math environments and repairs escaped stars", () => {
    const { container } = render(
      <MarkdownContent text={[
        "\\begin{align\\*}",
        "x & = y \\\\",
        "a & = b",
        "\\end{align\\*}",
      ].join("\n")} />,
    );

    expect(container.querySelector(".katex-display")).toBeTruthy();
    expect(container.textContent).not.toContain("\\begin{align\\*}");
    expect(container.textContent).not.toContain("\\end{align\\*}");
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

  it("scales a Mermaid diagram down to the canvas instead of overflowing it", async () => {
    // Regression: the stage used to be pinned to the diagram's intrinsic width,
    // so a flowchart wider than the chat column overflowed into a horizontal
    // scrollbar and only rendered a cropped slice — edges appeared to be cut.
    const { default: mermaid } = await import("mermaid");
    vi.mocked(mermaid.render).mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 1842 86" style="max-width: 1842px;" role="img"><text>Wide</text></svg>',
    } as Awaited<ReturnType<typeof mermaid.render>>);

    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    // jsdom reports 0 for every layout box; stand in for a 1000px canvas with
    // the stylesheet's 18px horizontal padding (964px of usable width).
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1000);
    const computedStyle = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ paddingLeft: "18px", paddingRight: "18px" } as CSSStyleDeclaration);

    try {
      const { container } = render(
        <MarkdownContent text={"```mermaid\nflowchart LR\n  A --> B\n```"} />,
      );

      await screen.findByTestId("mermaid-diagram");
      const stage = container.querySelector(".md-mermaid-stage") as HTMLElement;

      // 964 / 1842 ≈ 0.523, so the stage fits the canvas and keeps the aspect.
      expect(stage.style.width).toBe("964px");
      expect(stage.style.height).toBe("45px");
      // mermaid's own max-width cap would pin the SVG at 1842px and defeat zoom.
      expect(container.querySelector(".md-mermaid-diagram")?.innerHTML).not.toContain("max-width");
    } finally {
      clientWidth.mockRestore();
      computedStyle.mockRestore();
      vi.unstubAllGlobals();
    }
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

describe("MarkdownContent local links", () => {
  it("opens a cited paper page and quote in the chat PDF side panel", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownContent
        text="The sample is small [paper-1 p.2]."
        evidenceSources={[{
          paperId: "paper-1",
          page: 2,
          citation: "[paper-1 p.2]",
          pdfPath: ".somniq/papers/paper-1.pdf",
          quotes: ["Only 20 samples were used in the evaluation."],
        }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /paper-1.*p\.2/ }));

    expect(useStore.getState().pendingSidePanelEvidence).toMatchObject({
      path: ".somniq/papers/paper-1.pdf",
      paperId: "paper-1",
      page: 2,
      citation: "[paper-1 p.2]",
      quotes: ["Only 20 samples were used in the evaluation."],
    });
    expect(useStore.getState().tab).toBe("chat");
  });

  it("keeps a citation bound to its paper, page, and PDF when sources are reordered", async () => {
    const user = userEvent.setup();
    const target = {
      paperId: "paper-1",
      page: 2,
      citation: "[paper-1 p.2]",
      pdfPath: ".somniq/papers/paper-1.pdf",
      quotes: ["target quote"],
    };
    const other = {
      paperId: "paper-2",
      page: 2,
      citation: "[paper-2 p.2]",
      pdfPath: ".somniq/papers/paper-2.pdf",
      quotes: ["other quote"],
    };
    const { rerender } = render(
      <MarkdownContent text="The sample is small [paper-1 p.2]." evidenceSources={[target, other]} />,
    );

    rerender(<MarkdownContent text="The sample is small [paper-1 p.2]." evidenceSources={[other, target]} />);
    await user.click(screen.getByRole("button", { name: /paper-1.*p\.2/ }));

    expect(useStore.getState().pendingSidePanelEvidence).toMatchObject({
      path: target.pdfPath,
      paperId: target.paperId,
      page: target.page,
      quotes: target.quotes,
    });
  });

  it("does not turn citations inside code into PDF buttons", () => {
    render(
      <MarkdownContent
        text="`[paper-1 p.2]`"
        evidenceSources={[{
          paperId: "paper-1",
          page: 2,
          citation: "[paper-1 p.2]",
          pdfPath: ".somniq/papers/paper-1.pdf",
          quotes: [],
        }]}
      />,
    );

    expect(screen.queryByRole("button", { name: /paper-1.*p\.2/ })).toBeNull();
    expect(screen.getByText("[paper-1 p.2]")).toBeTruthy();
  });

  it("opens an encoded Windows export directory", async () => {
    render(
      <MarkdownContent text="[Open export folder](C%3A/Users/wt/.config/SomniQ/desktop-runtime)" />,
    );

    screen.getByRole("link", { name: "Open export folder" }).click();

    expect(apiMocks.fileOpen).toHaveBeenCalledWith("C:/Users/wt/.config/SomniQ/desktop-runtime");
  });

  it.each([
    ["raw Windows drive path", "[Open source](F:/Agent/Aris/desktop/src/chat/Chat.tsx:347)"],
    ["raw Windows backslashes", "[Open source](F:\\Agent\\Aris\\desktop\\src\\chat\\Chat.tsx:347)"],
    ["encoded backslashes", "[Open source](F:%5CAgent%5CAris%5Cdesktop%5Csrc%5Cchat%5CChat.tsx:347)"],
    ["VS Code file URI", "[Open source](vscode://file/F:/Agent/Aris/desktop/src/chat/Chat.tsx:347)"],
  ])("opens a %s in the Code workspace", async (_case, markdown) => {
    const user = userEvent.setup();
    render(<MarkdownContent text={markdown} />);

    await user.click(screen.getByRole("link", { name: "Open source" }));

    expect(apiMocks.codeBridgeOpenFile).toHaveBeenCalledWith("F:/Agent/Aris/desktop/src/chat/Chat.tsx");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("opens a non-workspace file URI externally", async () => {
    const user = userEvent.setup();
    render(<MarkdownContent text="[Open source](file:///F:/Agent/Aris/notes/archive.txt)" />);

    await user.click(screen.getByRole("link", { name: "Open source" }));

    expect(apiMocks.fileOpen).toHaveBeenCalledWith("F:/Agent/Aris/notes/archive.txt");
  });

  it("opens a local LaTeX source in the LaTeX workspace", async () => {
    const user = userEvent.setup();
    render(<MarkdownContent text="[Open source](<F:/研究 项目/论文/main.tex#L12C3>)" />);

    await user.click(screen.getByRole("link", { name: "Open source" }));

    expect(useStore.getState().tab).toBe("typeset");
    expect(useStore.getState().pendingTypesetFilePath).toBe("F:/研究 项目/论文/main.tex");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("opens a Windows LaTeX source with a line and column suffix in the LaTeX workspace", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownContent
        text="[Open source](<G:/2-博士期间资料/0-毕业材料/Final/Ch5/ch5_sparse_extremes.tex:42:7>)"
      />,
    );

    await user.click(screen.getByRole("link", { name: "Open source" }));

    expect(useStore.getState().tab).toBe("typeset");
    expect(useStore.getState().pendingTypesetFilePath).toBe(
      "G:/2-博士期间资料/0-毕业材料/Final/Ch5/ch5_sparse_extremes.tex",
    );
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("reads a local PDF link in the chat side panel", async () => {
    const user = userEvent.setup();
    render(<MarkdownContent text="[Open source](../papers/main.pdf)" />);

    await user.click(screen.getByRole("link", { name: "Open source" }));

    expect(useStore.getState().pendingSidePanelFilePath).toBe("../papers/main.pdf");
    expect(useStore.getState().tab).toBe("chat");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });
});
