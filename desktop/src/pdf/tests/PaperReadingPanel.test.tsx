// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PaperReadingView } from "../paperReadingApi";
import { guideFixture, layeredGuideFixture } from "./paperGuideFixture";

const mocks = vi.hoisted(() => ({
  models: vi.fn(), get: vi.fn(), prepare: vi.fn(), source: vi.fn(), start: vi.fn(), cancel: vi.fn(),
  revision: vi.fn(), page: vi.fn(), followUps: vi.fn(), list: vi.fn(), load: vi.fn(), remove: vi.fn(), ask: vi.fn(),
  updated: null as null | ((value: PaperReadingView) => void),
  failed: null as null | ((value: { projectId: string; runId: string; message: string }) => void),
}));
vi.mock("../../api/tauri", () => ({ chatModelOptions: mocks.models }));
vi.mock("../../store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ language: "cn", currentProject: { id: "project-1" } }),
}));
vi.mock("../paperReadingApi", () => ({
  paperReadingGet: mocks.get, paperReadingPrepare: mocks.prepare,
  paperReadingSource: mocks.source, paperReadingStart: mocks.start,
  paperReadingCancel: mocks.cancel,
  paperReadingFollowUps: mocks.followUps, paperReadingList: mocks.list, paperReadingLoad: mocks.load,
  paperReadingDelete: mocks.remove, paperReadingAsk: mocks.ask,
  onPaperReadingUpdated: async (handler: typeof mocks.updated) => {
    mocks.updated = handler;
    return () => { mocks.updated = null; };
  },
  onPaperReadingError: async (handler: typeof mocks.failed) => {
    mocks.failed = handler;
    return () => { mocks.failed = null; };
  },
}));
vi.mock("../pdfExtraction", () => ({
  paperDocumentRevision: mocks.revision,
  preparePaperPageEvidence: mocks.page,
}));
import PaperReadingPanel from "../PaperReadingPanel";

const hash = "a".repeat(64);
const document = { numPages: 2 } as PDFDocumentProxy;
const source = (pageIndex: number) => ({
  documentRevision: hash, pageIndex, imageSha256: "b".repeat(64),
});
function initial(): PaperReadingView {
  return {
    projectId: "project-1", active: false,
    run: {
      id: "c".repeat(64), revision: 1, paperId: "paper-1", title: "Paper",
      relativePath: "papers/test.pdf", documentRevision: hash, totalPages: 2,
      model: "vision-model", language: "zh", status: "preparing",
      executorSignature: "d".repeat(64), lastError: null,
      pages: [0, 1].map(pageIndex => ({
        pageIndex, status: "awaiting_source", source: null, result: null, attempts: [], error: null,
      })),
    },
    coverage: {
      pageProcessingCoverage: { completed: 0, failed: 0, total: 2 },
      identifiedContentCoverage: {
        inventoryVersion: 1, candidatesByKind: { text: 0, formula: 0, figure: 0, table: 0 },
        understanding: "not_started", teaching: "not_started", review: "not_requested",
      },
      recognitionCompleteness: { status: "not_checked", checkedPages: [], expectedItems: null, matchedItems: null },
      reviewStatus: "not_reviewed",
    },
  };
}
let backend: PaperReadingView;
beforeEach(() => {
  vi.clearAllMocks();
  backend = initial();
  mocks.models.mockResolvedValue({ current: "vision-model", options: [{ value: "vision-model", label: "Vision A", description: null }, { value: "vision-b", label: "Vision B", description: null }] });
  mocks.get.mockResolvedValue(null);
  mocks.followUps.mockResolvedValue([]);
  mocks.list.mockResolvedValue([]);
  mocks.prepare.mockImplementation(async () => structuredClone(backend));
  mocks.revision.mockResolvedValue(hash);
  mocks.page.mockResolvedValue({ imageBase64: "original-image", embeddedText: "Original", textTruncated: false });
  mocks.source.mockImplementation(async input => {
    backend.run.revision += 1;
    backend.run.pages[input.pageIndex].source = source(input.pageIndex);
    backend.run.pages[input.pageIndex].status = "pending";
    return structuredClone(backend);
  });
  mocks.start.mockImplementation(async () => {
    backend.active = true;
    backend.run.status = "running";
    backend.run.revision += 1;
    return structuredClone(backend);
  });
  mocks.cancel.mockImplementation(async () => {
    backend.active = false;
    backend.run.status = "cancelled";
    backend.run.revision += 1;
    return structuredClone(backend);
  });
});
afterEach(cleanup);

const show = (onJump = vi.fn()) => {
  render(<PaperReadingPanel paperId="paper-1" relativePath="papers/test.pdf" document={document} onJump={onJump} />);
  return onJump;
};

describe("paper perception task", () => {
  it("one click prepares every page then dispatches one backend task", async () => {
    show();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    const button = screen.getByRole("button", { name: "多模态论文解析" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1", documentRevision: hash, language: "zh",
    }));
    expect(mocks.page.mock.calls.map(call => call[1])).toEqual([0, 1]);
    expect(mocks.source).toHaveBeenCalledTimes(2);
    expect(mocks.source.mock.invocationCallOrder[1]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]);
    expect(screen.getByText("识别完整性：未验证")).toBeTruthy();
  });

  it("extends cached perception into explanations without processing the PDF again", async () => {
    backend.run.status = "page_processing_complete";
    backend.run.pages.forEach((page, index) => {
      page.status = "completed";
      page.source = source(index);
      page.result = { pageIndex: index, items: [{ kind: "formula", content: "x = 1", uncertainties: [] }], warnings: [] };
    });
    backend.coverage.pageProcessingCoverage.completed = 2;
    backend.coverage.identifiedContentCoverage.candidatesByKind.formula = 2;
    mocks.get.mockResolvedValue(structuredClone(backend));
    const onJump = show();
    fireEvent.click(await screen.findByRole("button", { name: "生成论文讲解" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(screen.getByText("页面处理: 2/2 · 0 失败")).toBeTruthy();
    expect(screen.getByText("识别完整性：未验证")).toBeTruthy();
    expect(screen.getByText("理解与教学：未执行 · 尚未独立审核")).toBeTruthy();
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "原文识别" }));
    fireEvent.click(screen.getByRole("button", { name: "查看原页 2", hidden: true }));
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("continues a saved task without rerendering its original page sources", async () => {
    backend.run.id = "e".repeat(64);
    backend.run.status = "partial";
    backend.run.pages.forEach((page, index) => { page.source = source(index); page.status = "failed"; });
    backend.run.pages[0].status = "completed";
    mocks.get.mockResolvedValue(structuredClone(backend));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "继续生成／重试失败内容" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("project-1", "e".repeat(64)));
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ runId: "e".repeat(64) }));
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it("cancels during page preparation without sending a model task", async () => {
    let finishPage: ((value: unknown) => void) | undefined;
    mocks.page.mockImplementation(() => new Promise(resolve => { finishPage = resolve; }));
    show();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "多模态论文解析" }));
    await waitFor(() => expect(mocks.page).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => { finishPage?.({ imageBase64: "image", embeddedText: "", textTruncated: false }); });
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalled());
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it("ignores late or cross-project progress after binding the task", async () => {
    mocks.get.mockResolvedValue(structuredClone(backend));
    show();
    await screen.findByRole("button", { name: "展开结果" });
    const other = structuredClone(backend);
    other.projectId = "project-2";
    other.active = true;
    other.run.revision = 50;
    await act(async () => { mocks.updated?.(other); });
    expect(screen.queryByText("正在解析页面")).toBeNull();
    const next = structuredClone(backend);
    next.run.revision = 10;
    next.run.status = "cancelled";
    await act(async () => { mocks.updated?.(next); });
    const late = structuredClone(backend);
    late.active = true;
    late.run.revision = 2;
    await act(async () => { mocks.updated?.(late); });
    expect(screen.getByText("已取消，可继续")).toBeTruthy();
  });

  it("stops before dispatch when original evidence preparation fails", async () => {
    mocks.page.mockRejectedValue(new Error("Cannot render original page"));
    show();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "多模态论文解析" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not let a delayed cache lookup replace a newly dispatched task", async () => {
    let finishGet: ((value: PaperReadingView) => void) | undefined;
    mocks.get.mockImplementation(() => new Promise(resolve => { finishGet = resolve; }));
    show();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "多模态论文解析" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalled());
    const old = initial();
    old.run.id = "f".repeat(64);
    old.run.status = "page_processing_complete";
    await act(async () => { finishGet?.(old); });
    expect(screen.queryByRole("button", { name: "查看论文讲解" })).toBeNull();
    expect(screen.getByRole("button", { name: "正在解析页面" })).toBeTruthy();
  });

  it("ignores a cancellation response after switching to another paper", async () => {
    backend.active = true;
    backend.run.status = "running";
    mocks.get.mockResolvedValue(structuredClone(backend));
    let finishCancel: ((value: PaperReadingView) => void) | undefined;
    mocks.cancel.mockImplementation(() => new Promise(resolve => { finishCancel = resolve; }));
    const panel = render(<PaperReadingPanel paperId="paper-1" relativePath="papers/test.pdf" document={document} onJump={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    const next = initial();
    next.run.paperId = "paper-2";
    next.run.id = "e".repeat(64);
    mocks.get.mockResolvedValue(next);
    panel.rerender(<PaperReadingPanel paperId="paper-2" relativePath="papers/second.pdf" document={document} onJump={vi.fn()} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    const cancelled = structuredClone(backend);
    cancelled.active = false;
    cancelled.run.status = "cancelled";
    await act(async () => { finishCancel?.(cancelled); });
    expect(screen.queryByText("已取消，可继续")).toBeNull();
  });

  it("opens a saved guide as the primary result without another generation", async () => {
    backend.run.status = "guide_ready";
    backend.run.guide = guideFixture();
    mocks.get.mockResolvedValue(structuredClone(backend));
    show();
    await screen.findByRole("tab", { name: "图文讲解" });
    expect(screen.getByRole("tab", { name: "图文讲解" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("navigation", { name: "阅读目录" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /为什么除以维度的平方根/ }));
    expect(screen.getByRole("heading", { name: "一步步理解" })).toBeTruthy();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("keeps manual continuation available after the automatic budget is exhausted", async () => {
    backend.run.status = "partial";
    backend.run.pages.forEach((page, index) => { page.source = source(index); page.status = "completed"; });
    backend.coverage.pageProcessingCoverage.completed = 2;
    const guide = guideFixture();
    guide.outline.status = "failed";
    guide.outline.result = null;
    guide.outline.error = "Invalid explanation JSON: invalid type: map, expected a string";
    guide.outline.attempts = [0, 1, 2].map(index => ({ sessionId: `old-${index}`, status: "failed", evidence: [], error: "Invalid JSON" }));
    guide.lessons = [];
    backend.run.guide = guide;
    mocks.get.mockResolvedValue(structuredClone(backend));
    show();
    const button = await screen.findByRole("button", { name: "重试未完成内容" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("不需要重新导入 PDF");
    const rawError = screen.getByText(guide.outline.error);
    expect(rawError.closest("details")?.open).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens local web reading and returns to PDF when a source is selected", async () => {
    backend.run.status = "guide_ready";
    backend.run.guide = guideFixture();
    mocks.get.mockResolvedValue(structuredClone(backend));
    const onJump = show();
    fireEvent.click(await screen.findByRole("button", { name: "专注阅读" }));
    expect(screen.getByRole("complementary").classList.contains("web-reading")).toBe(true);
    expect(screen.getByRole("navigation", { name: "阅读目录" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /对照原文 1/ })[0]);
    expect(onJump).toHaveBeenCalledWith(1);
    expect(screen.getByRole("complementary").classList.contains("web-reading")).toBe(false);
  });

  it("switches a finished paper to the chosen model and ignores updates from its old run", async () => {
    backend.run.status = "guide_ready";
    backend.run.guide = guideFixture();
    const old = structuredClone(backend);
    mocks.get.mockResolvedValue(old);
    mocks.prepare.mockImplementation(async input => {
      expect(input.model).toBe("vision-b");
      backend = initial(); backend.run.model = "vision-b"; backend.run.id = "b".repeat(64);
      return structuredClone(backend);
    });
    show();
    await screen.findByRole("navigation", { name: "阅读目录" });
    fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), { target: { value: "vision-b" } });
    fireEvent.click(screen.getByRole("button", { name: "用所选模型生成" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("project-1", "b".repeat(64)));
    expect((screen.getByRole("combobox", { name: "生成模型" }) as HTMLSelectElement).disabled).toBe(true);
    old.run.revision = 999;
    await act(async () => { mocks.updated?.(old); });
    expect((screen.getByRole("combobox", { name: "生成模型" }) as HTMLSelectElement).value).toBe("vision-b");
  });

  it("uses an existing completed result when switching back to its model", async () => {
    backend.run.status = "guide_ready"; backend.run.guide = guideFixture();
    mocks.get.mockResolvedValue(structuredClone(backend));
    mocks.prepare.mockImplementation(async input => ({ ...structuredClone(backend), run: { ...structuredClone(backend.run), id: "b".repeat(64), model: input.model } }));
    show();
    await screen.findByRole("navigation", { name: "阅读目录" });
    fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), { target: { value: "vision-b" } });
    fireEvent.click(screen.getByRole("button", { name: "用所选模型生成" }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "生成模型" }) as HTMLSelectElement).value).toBe("vision-b"));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalled());
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("regenerates a completed guide as a fresh run with the selected model", async () => {
    backend.run.status = "guide_ready"; backend.run.guide = guideFixture();
    mocks.get.mockResolvedValue(structuredClone(backend));
    mocks.prepare.mockImplementation(async () => {
      backend = initial(); backend.run.id = "e".repeat(64);
      return structuredClone(backend);
    });
    show();
    await screen.findByRole("navigation", { name: "阅读目录" });
    fireEvent.click(screen.getByRole("button", { name: "重新生成讲解" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("project-1", "e".repeat(64)));
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ regenerate: true, model: "vision-model" }));
    expect(mocks.prepare.mock.calls[0][0].runId).toBeUndefined();
  });

  it("hides and reopens a guide without cancelling or losing the selected task", async () => {
    backend.run.status = "guide_ready"; backend.run.guide = guideFixture();
    mocks.get.mockResolvedValue(structuredClone(backend));
    const onClose = vi.fn();
    const props = { paperId: "paper-1", relativePath: "papers/test.pdf", document, onJump: vi.fn(), onClose };
    const { rerender, container } = render(<PaperReadingPanel {...props} />);
    await screen.findByRole("navigation", { name: "阅读目录" });
    fireEvent.click(screen.getByRole("button", { name: "专注阅读" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭讲解" }));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<PaperReadingPanel {...props} hidden />);
    expect(container.querySelector("aside")?.style.display).toBe("none");
    expect(container.querySelector(".web-reading")).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
    rerender(<PaperReadingPanel {...props} />);
    expect(screen.getByRole("navigation", { name: "阅读目录" })).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

});

describe("resuming, versions and questions", () => {
  it("continues an interrupted task in its own language after the interface language changed", async () => {
    backend.run.id = "e".repeat(64);
    backend.run.language = "en";
    backend.run.status = "partial";
    backend.run.pages.forEach((page, index) => { page.source = source(index); page.status = "failed"; });
    mocks.get.mockResolvedValue(structuredClone(backend));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "继续生成／重试失败内容" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalled());
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ runId: "e".repeat(64), language: "en" }));
  });

  it("regenerates a version saved by an earlier release instead of resuming it", async () => {
    backend.run.id = "e".repeat(64);
    backend.resumable = false;
    backend.run.status = "partial";
    backend.run.pages.forEach((page, index) => { page.source = source(index); page.status = "completed"; });
    mocks.get.mockResolvedValue(structuredClone(backend));
    mocks.prepare.mockImplementation(async () => {
      backend = initial(); backend.run.id = "f".repeat(64);
      return structuredClone(backend);
    });
    show();
    expect(await screen.findByRole("note")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "按新版重新生成" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("project-1", "f".repeat(64)));
    expect(mocks.prepare.mock.calls[0][0].runId).toBeUndefined();
  });

  it("switches between saved versions of this PDF and deletes one", async () => {
    backend.run.status = "guide_ready"; backend.run.guide = layeredGuideFixture();
    mocks.get.mockResolvedValue(structuredClone(backend));
    const version = (id: string, documentRevision = hash) => ({
      id, model: "vision-model", language: "zh", status: "guide_ready" as const, documentRevision,
      createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z", resumable: true, active: false,
      lessonsTotal: 2, lessonsReady: 2, reviewStatus: "all_passed",
    });
    mocks.list.mockResolvedValue([version(backend.run.id), version("b".repeat(64)), version("9".repeat(64), "0".repeat(64))]);
    const other = structuredClone(backend);
    other.run.id = "b".repeat(64); other.run.revision = 1;
    mocks.load.mockResolvedValue(other);
    mocks.remove.mockResolvedValue(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    show();
    const picker = await screen.findByRole("combobox", { name: "讲解版本" });
    expect(picker.querySelectorAll("option").length).toBe(2);
    fireEvent.change(picker, { target: { value: "b".repeat(64) } });
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("project-1", "b".repeat(64)));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "讲解版本" }) as HTMLSelectElement).value).toBe("b".repeat(64)));
    fireEvent.click(screen.getByRole("button", { name: "删除此版本" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("project-1", "b".repeat(64)));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    confirm.mockRestore();
  });

  it("reads text-layer pages directly and transcribes them only on request", async () => {
    backend.run.status = "page_processing_complete";
    backend.run.pages.forEach((page, index) => { page.source = source(index); page.status = "not_required"; });
    backend.coverage.pageProcessingCoverage.notRequired = 2;
    mocks.get.mockResolvedValue(structuredClone(backend));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "展开结果" }));
    fireEvent.click(screen.getByRole("tab", { name: "原文识别" }));
    expect(screen.getByText(/2 页有可用的 PDF 文本层/)).toBeTruthy();
    expect(screen.getAllByText(/直接读取文本层/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /逐页识别这些页面/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("project-1", backend.run.id, true));
  });

  it("asks a question about a lesson and shows the answer from the original pages", async () => {
    backend.run.status = "guide_ready"; backend.run.guide = layeredGuideFixture();
    mocks.get.mockResolvedValue(structuredClone(backend));
    mocks.ask.mockImplementation(async input => ({
      id: "q1", runId: input.runId, target: input.target, focus: input.focus ?? null, mode: input.mode,
      question: input.question ?? "", answer: "换个更简单的说法：先看谁和谁更相关。", model: "vision-model", sessionId: "s", createdAt: "t",
    }));
    show();
    await screen.findByRole("navigation", { name: "阅读目录" });
    fireEvent.click(screen.getAllByRole("button", { name: /什么是注意力/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "讲得更简单" }));
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", runId: backend.run.id, target: "lesson:0", mode: "simpler" })));
    expect(await screen.findByText("换个更简单的说法：先看谁和谁更相关。")).toBeTruthy();
  });
});

describe("independent review", () => {
  it("lets a finished guide be reviewed after a Reviewer is configured", async () => {
    backend.run.id = "e".repeat(64);
    backend.run.status = "guide_ready";
    backend.run.guide = layeredGuideFixture();
    backend.run.pages.forEach((page, index) => { page.source = source(index); page.status = "not_required"; });
    backend.coverage.reviewCounts = { passed: 1, needsRevision: 0, insufficientEvidence: 0, unavailable: 1, pending: 0 };
    mocks.get.mockResolvedValue(structuredClone(backend));
    show();
    expect(await screen.findByText(/部分讲解未能独立审核/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "补做独立审核" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("project-1", "e".repeat(64)));
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ runId: "e".repeat(64) }));
    expect(mocks.page).not.toHaveBeenCalled();
  });
});
