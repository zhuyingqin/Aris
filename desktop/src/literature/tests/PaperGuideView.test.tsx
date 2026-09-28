// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { guideFixture, layeredGuideFixture } from "./paperGuideFixture";

const cancel = vi.fn();
vi.mock("../../pdf/canvas", () => ({ renderPdfPageToCanvas: () => ({ task: { promise: Promise.resolve(), cancel } }) }));
import PaperGuideView from "../PaperGuideView";

afterEach(cleanup);

describe("the reader-facing multimodal guide", () => {
  it("keeps topic navigation inside the reading panel without scrolling window chrome", () => {
    const { container } = render(<div className="lit-paper-analysis"><PaperGuideView guide={guideFixture()} document={null} onJump={vi.fn()} language="cn" /></div>);
    const panel = container.querySelector<HTMLElement>(".lit-paper-analysis")!;
    const main = container.querySelector<HTMLElement>(".paper-essay-main")!;
    panel.scrollTop = 200;
    panel.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    main.getBoundingClientRect = () => ({ top: 180 } as DOMRect);
    panel.scrollTo = vi.fn();
    main.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: /为什么除以维度的平方根/ }));
    expect(panel.scrollTo).toHaveBeenCalledWith({ top: 254, behavior: "smooth" });
    expect(main.scrollIntoView).not.toHaveBeenCalled();
  });

  it("connects the argument, original page previews, teaching steps and a check question", async () => {
    const getPage = vi.fn().mockResolvedValue({ getViewport: () => ({ width: 600, height: 800 }) });
    const document = { getPage } as unknown as PDFDocumentProxy;
    const onJump = vi.fn();
    const { container, unmount } = render(<PaperGuideView guide={guideFixture()} document={document} onJump={onJump} language="cn" />);
    expect(screen.getByRole("navigation", { name: "阅读目录" })).toBeTruthy();
    expect(screen.getByText("这篇论文解决序列建模中的并行计算问题。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /为什么除以维度的平方根/ }));
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看原图" }));
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(2));
    expect(container.querySelector("canvas")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "对照原文 2" })[0]);
    expect(onJump).toHaveBeenLastCalledWith(2);
    expect(container.querySelector("math")).toBeTruthy();
    expect(screen.getByText("各分量独立、均值为零、方差为一。")).toBeTruthy();
    expect(screen.getByText("教学构造示例，不是论文实验结果")).toBeTruthy();
    fireEvent.click(screen.getByText("展开参考答案"));
    expect(screen.getByText("不能，还需要考虑协方差项。")).toBeTruthy();
    expect(screen.getByText("讲解草稿 · 尚未独立审核")).toBeTruthy();
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it("retains an available explanation while a different topic failed", () => {
    const guide = guideFixture();
    guide.lessons[1].task = { status: "failed", result: null, error: "Source image unavailable", attempts: [] };
    render(<PaperGuideView guide={guide} document={null} onJump={vi.fn()} language="cn" />);
    fireEvent.click(screen.getAllByRole("button", { name: /数据如何经过模型/ })[0]);
    expect(screen.getByRole("heading", { name: "先建立直觉" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /为什么除以维度的平方根/ }));
    expect(screen.queryByText("先建立直觉")).toBeNull();
    expect(screen.getByText("Source image unavailable").closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByText("查看错误详情"));
    expect(screen.getByText("Source image unavailable").closest("details")?.open).toBe(true);
    expect(screen.getByText("这个主题尚未生成成功，可从上方继续重试。")).toBeTruthy();
  });
  it("opens the full original for a figure and keeps topic navigation separate from PDF jumps", async () => {
    const getPage = vi.fn().mockResolvedValue({ getViewport: () => ({ width: 600, height: 800 }) });
    const document = { getPage } as unknown as PDFDocumentProxy;
    const onJump = vi.fn();
    render(<PaperGuideView guide={guideFixture()} document={document} onJump={onJump} language="cn" title="Paper title" />);
    expect(screen.getByRole("heading", { name: "Paper title" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /数据如何经过模型/ })[0]);
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /在 PDF 中定位/ }));
    expect(onJump).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: /下一主题/ }));
    expect(screen.getByRole("heading", { name: "为什么除以维度的平方根？" })).toBeTruthy();
    expect(screen.queryByLabelText("PDF 原文第 1 页")).toBeNull();
  });

});

describe("layered teaching from simple to deep", () => {
  it("opens with the paper in one sentence, key terms and a leveled reading path", () => {
    render(<PaperGuideView guide={layeredGuideFixture()} document={null} onJump={vi.fn()} language="cn" />);
    expect(screen.getByText("这篇论文只用注意力来翻译句子，从而可以并行计算。")).toBeTruthy();
    expect(screen.getByRole("region", { name: "关键术语：先认识这些词" }).textContent).toContain("按相关程度给信息加权平均。");
    const path = screen.getByRole("region", { name: "阅读路线：由浅入深" });
    expect(path.textContent?.indexOf("打基础")).toBeLessThan(path.textContent?.indexOf("核心思想") ?? 0);
    expect(path.textContent).toContain("先读懂：点积");
    expect(screen.getByText("注意力打分方式可用于你的检索模型。")).toBeTruthy();
    expect(screen.getByRole("button", { name: /从基础开始学习/ })).toBeTruthy();
  });

  it("shows essentials first and reveals notation and derivation on request", () => {
    render(<div className="lit-paper-analysis"><PaperGuideView guide={layeredGuideFixture()} document={null} onJump={vi.fn()} language="cn" /></div>);
    fireEvent.click(screen.getAllByRole("button", { name: /什么是注意力/ })[0]);
    for (const heading of ["一句话看懂", "打个比方", "先补基础", "先建立直觉", "容易想错的地方", "检查自己是否理解"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }
    expect(screen.getByText("注意力就是按相关程度加权。")).toBeTruthy();
    expect(screen.getByText("缩放保证训练一定稳定。")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "一步步理解" })).toBeNull();
    expect(screen.getByText("独立审核通过")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /继续深入/ }));
    expect(screen.getByRole("heading", { name: "一步步理解" })).toBeTruthy();
    expect(screen.getByText("各分量独立、均值为零、方差为一。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "完整" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the revised lesson and its re-check instead of the rejected draft", () => {
    render(<PaperGuideView guide={layeredGuideFixture()} document={null} onJump={vi.fn()} language="cn" />);
    fireEvent.click(screen.getAllByRole("button", { name: /为什么要缩放/ })[0]);
    expect(screen.getByText("缩放让分数保持在合适的范围。")).toBeTruthy();
    expect(screen.queryByText("第一版草稿。")).toBeNull();
    expect(screen.getAllByText("已按审核意见修订 · 复核通过").length).toBeGreaterThan(0);
  });

  it("keeps unresolved review findings visible to the reader", () => {
    const guide = layeredGuideFixture();
    guide.lessons[1].revision = { status: "failed", result: null, attempts: [], error: "Invalid explanation JSON" };
    guide.lessons[1].reviews = guide.lessons[1].reviews!.slice(0, 1);
    render(<PaperGuideView guide={guide} document={null} onJump={vi.fn()} language="cn" />);
    fireEvent.click(screen.getAllByRole("button", { name: /为什么要缩放/ })[0]);
    expect(screen.getByText("第一版草稿。")).toBeTruthy();
    expect(screen.getAllByText("独立审核发现问题").length).toBeGreaterThan(0);
    const details = screen.getByText(/独立审核 · 独立审核发现问题/).closest("details")!;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("改为置换等变。");
  });

  it("answers a stuck reader where they asked, and saves a lesson to notes", async () => {
    const onAsk = vi.fn().mockResolvedValue(undefined);
    const onSaveNote = vi.fn();
    const guide = layeredGuideFixture();
    const { rerender } = render(<PaperGuideView guide={guide} document={null} onJump={vi.fn()} language="cn" onAsk={onAsk} onSaveNote={onSaveNote} />);
    fireEvent.click(screen.getAllByRole("button", { name: /为什么要缩放/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "完整" }));
    fireEvent.click(screen.getAllByRole("button", { name: "这一步没懂？" })[1]);
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith({ target: "lesson:1", mode: "simpler", question: undefined, focus: "除以平方根" }));
    const answer = { id: "a1", runId: "r", target: "lesson:1", focus: "除以平方根", mode: "simpler" as const, question: "", answer: "把分数除以 4，就回到了原来的尺度。", model: "m", sessionId: "s", createdAt: "t" };
    rerender(<PaperGuideView guide={guide} document={null} onJump={vi.fn()} language="cn" onAsk={onAsk} onSaveNote={onSaveNote} followUps={[answer]} />);
    const step = screen.getByRole("heading", { name: "除以平方根" }).closest("li")!;
    expect(step.textContent).toContain("把分数除以 4，就回到了原来的尺度。");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Q 和 K 是什么？" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(onAsk).toHaveBeenLastCalledWith({ target: "lesson:1", mode: "question", question: "Q 和 K 是什么？", focus: undefined }));
    fireEvent.click(screen.getByRole("button", { name: "保存到笔记" }));
    expect(onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ title: "为什么要缩放？" }));
    const note = onSaveNote.mock.calls[0][0].content as string;
    expect(note).toContain("缩放让分数保持在合适的范围。");
    expect(note).toContain("已按审核意见修订 · 复核通过");
    expect(screen.getByRole("button", { name: "已保存到文献笔记" })).toBeTruthy();
  });
});
