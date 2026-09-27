// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { guideFixture } from "./paperGuideFixture";

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
