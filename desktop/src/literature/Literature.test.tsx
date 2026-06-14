// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiteratureLibrary, LiteraturePaper } from "./literatureTypes";

const mocks = vi.hoisted(() => ({
  literatureLoad: vi.fn(),
  literatureSave: vi.fn(),
  literatureSearch: vi.fn(),
  literatureLibraryUpsert: vi.fn(),
  literatureDownloadPdf: vi.fn(),
  literatureImportPdf: vi.fn(),
  literatureLlm: vi.fn(),
  literatureReviewLlm: vi.fn(),
  literatureLlmVision: vi.fn(),
  literaturePdfOpen: vi.fn(),
  literaturePdfText: vi.fn(),
  literaturePdfImages: vi.fn(),
  literaturePdfBytes: vi.fn(),
  chatRunCommand: vi.fn(),
  literatureAgentSend: vi.fn(),
  onChatDone: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolResult: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  literatureLoad: mocks.literatureLoad,
  literatureSave: mocks.literatureSave,
  literatureSearch: mocks.literatureSearch,
  literatureLibraryUpsert: mocks.literatureLibraryUpsert,
  literatureDownloadPdf: mocks.literatureDownloadPdf,
  literatureImportPdf: mocks.literatureImportPdf,
  literatureLlm: mocks.literatureLlm,
  literatureReviewLlm: mocks.literatureReviewLlm,
  literatureLlmVision: mocks.literatureLlmVision,
  literaturePdfOpen: mocks.literaturePdfOpen,
  literaturePdfText: mocks.literaturePdfText,
  literaturePdfBytes: mocks.literaturePdfBytes,
  chatRunCommand: mocks.chatRunCommand,
  literatureAgentSend: mocks.literatureAgentSend,
  onChatDone: mocks.onChatDone,
  onChatTool: mocks.onChatTool,
  onChatToolResult: mocks.onChatToolResult,
  projectAdd: vi.fn(),
  projectsGet: vi.fn(),
  projectsReorder: vi.fn(),
  projectSetCurrent: vi.fn(),
  stateDir: vi.fn(),
}));

vi.mock("./pdfExtraction", () => ({
  extractPdfTextByPage: mocks.literaturePdfText,
  extractPdfPageImages: mocks.literaturePdfImages,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import Literature from "./Literature";
import { resetLiteratureStore, useLiteratureStore } from "./literatureStore";
import { useStore } from "../store";

let chatDoneHandler: ((text: string) => void) | null = null;
let chatToolHandler:
  | ((tool: { id?: string; name: string; input: string }) => void)
  | null = null;
let chatToolResultHandler:
  | ((result: { id?: string; name: string; output: string; isError: boolean }) => void)
  | null = null;

const fixturePaper: LiteraturePaper = {
  id: "arxiv:1111.00001",
  title: "Persisted Paper on Grounded Reading",
  authors: ["A. One", "B. Two"],
  year: 2025,
  venue: "arXiv",
  arxivId: "1111.00001",
  url: "https://arxiv.org/abs/1111.00001",
  abstract: "A previously saved record loaded from papers/library.json.",
  tags: ["reading"],
  collectionIds: [],
  searchIds: [],
  stage: "inbox",
  starred: false,
  unread: true,
  source: "arXiv",
  addedAt: "2026-06-01T00:00:00.000Z",
  pdf: { status: "none", url: "https://arxiv.org/pdf/1111.00001.pdf" },
  evidence: [],
  answerChains: [],
  pdfAnnotations: [],
};

const fixtureLibrary = (): LiteratureLibrary => ({
  version: 1,
  papers: [structuredClone(fixturePaper)],
  searches: [],
  collections: [],
  reviewTasks: [],
});

beforeEach(() => {
  resetLiteratureStore();
  useStore.setState({ tab: "literature", pendingChatInput: null, pendingChatRunInput: null });
  chatDoneHandler = null;
  chatToolHandler = null;
  chatToolResultHandler = null;
  mocks.onChatDone.mockReset().mockImplementation((handler: (text: string) => void) => {
    chatDoneHandler = handler;
    return Promise.resolve(() => {});
  });
  mocks.onChatTool
    .mockReset()
    .mockImplementation(
      (handler: (tool: { id?: string; name: string; input: string }) => void) => {
        chatToolHandler = handler;
        return Promise.resolve(() => {});
      },
    );
  mocks.onChatToolResult
    .mockReset()
    .mockImplementation(
      (
        handler: (result: {
          id?: string;
          name: string;
          output: string;
          isError: boolean;
        }) => void,
      ) => {
        chatToolResultHandler = handler;
        return Promise.resolve(() => {});
      },
    );
  mocks.literatureLoad.mockReset().mockResolvedValue(fixtureLibrary());
  mocks.literatureSave.mockReset().mockResolvedValue(undefined);
  mocks.literatureSearch.mockReset().mockResolvedValue({
    papers: [
      {
        id: "arxiv:2602.01491",
        title: "Deep Retrieval Agents for Literature Triage",
        authors: ["M. Rivera"],
        year: 2026,
        venue: "arXiv",
        doi: null,
        arxivId: "2602.01491",
        abstract: "Fresh result coming back from the remote search.",
        url: "https://arxiv.org/abs/2602.01491",
        pdfUrl: "https://arxiv.org/pdf/2602.01491.pdf",
        source: "arXiv",
        published: "2026-02-03",
        citedBy: null,
      },
      {
        id: "arxiv:1111.00001",
        title: "Persisted Paper on Grounded Reading",
        authors: ["A. One", "B. Two"],
        year: 2025,
        venue: "arXiv",
        doi: "10.48550/arxiv.1111.00001",
        arxivId: "1111.00001",
        abstract: "Duplicate of the stored record.",
        url: "https://arxiv.org/abs/1111.00001",
        pdfUrl: "https://arxiv.org/pdf/1111.00001.pdf",
        source: "arXiv",
        published: "2025-01-15",
        citedBy: 4,
      },
    ],
    warnings: [],
    sourceCounts: [{ source: "arXiv", count: 2 }],
  });
  mocks.literatureDownloadPdf.mockReset().mockResolvedValue({
    path: "C:/project/papers/1111.00001.pdf",
    relativePath: "papers/1111.00001.pdf",
    bytes: 123456,
  });
  mocks.literatureImportPdf.mockReset().mockResolvedValue({
    path: "C:/project/papers/1111.00001.pdf",
    relativePath: "papers/1111.00001.pdf",
    bytes: 654321,
  });
  mocks.literatureLibraryUpsert.mockReset().mockResolvedValue({
    searchId: "search-new",
    added: 1,
    merged: 1,
    total: 2,
    libraryPath: "papers/library.json",
  });
  // Default: no executor configured, so screening/brief fall back to the
  // offline heuristic. Individual tests opt into the LLM path.
  mocks.literatureLlm.mockReset().mockRejectedValue(new Error("no executor configured"));
  mocks.literatureReviewLlm.mockReset().mockRejectedValue(new Error("no reviewer configured"));
  mocks.literatureLlmVision.mockReset().mockRejectedValue(new Error("no vision executor configured"));
  mocks.literaturePdfOpen.mockReset().mockResolvedValue(undefined);
  mocks.literaturePdfText.mockReset().mockRejectedValue(new Error("no pdf text"));
  mocks.literaturePdfImages.mockReset().mockRejectedValue(new Error("no pdf page images"));
  mocks.literaturePdfBytes.mockReset().mockRejectedValue(new Error("no pdf bytes"));
  mocks.chatRunCommand.mockReset().mockResolvedValue({
    handled: true,
    message: null,
    prompt: "Expanded /research-lit prompt",
    selection: null,
    replaceTurns: false,
    openSettings: false,
    refreshStatus: false,
  });
  mocks.literatureAgentSend.mockReset().mockResolvedValue("done");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Literature library", () => {
  it("loads the persisted library and shows pipeline counts", async () => {
    render(<Literature />);

    expect(await screen.findAllByText("Persisted Paper on Grounded Reading")).toBeTruthy();
    expect(mocks.literatureLoad).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "收件箱 1" })).toBeTruthy();
    expect(screen.getByText("1 paper · 0 PDFs")).toBeTruthy();
  });

  it("keeps the nav short by hiding empty later stages", async () => {
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    expect(screen.getByRole("button", { name: "收件箱 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "候选 0" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Screened 0" })).toBeNull();
    expect(screen.queryByRole("button", { name: "已阅读 0" })).toBeNull();
    expect(screen.queryByRole("button", { name: "已排除 0" })).toBeNull();
  });

  it("normalizes legacy records and clearly shows a missing abstract", async () => {
    const legacy = fixtureLibrary();
    const paper = legacy.papers[0] as Partial<LiteraturePaper>;
    delete paper.abstract;
    delete paper.tags;
    delete paper.evidence;
    delete paper.pdf;
    mocks.literatureLoad.mockResolvedValue(legacy);

    render(<Literature />);

    expect(await screen.findByText("当前元数据源未提供摘要。可尝试重新检索或从论文页面补充元数据。")).toBeTruthy();
    expect(screen.getByText("缺失")).toBeTruthy();
  });

  it("allows the paper workspace selection to be cleared", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "清除选择" }));

    expect(screen.getByText("Select a paper to open it here.")).toBeTruthy();
  });

  it("assigns and removes a paper from a collection in the Files tab", async () => {
    const user = userEvent.setup();
    const withCollection = fixtureLibrary();
    withCollection.collections = [{ id: "core", label: "Core review" }];
    mocks.literatureLoad.mockResolvedValue(withCollection);
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("tab", { name: "文件" }));
    await user.click(screen.getByRole("button", { name: "+ Core review" }));
    expect(screen.getByRole("button", { name: "✓ Core review" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "✓ Core review" }));
    expect(screen.getByRole("button", { name: "+ Core review" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("logs literature tool calls made by the agent in Chat", async () => {
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await waitFor(() => expect(chatToolHandler).not.toBeNull());

    await act(async () => {
      chatToolHandler?.({
        name: "LiteratureLibraryUpsert",
        input: JSON.stringify({ papers: [{}, {}, {}] }),
      });
      chatToolResultHandler?.({
        name: "LiteratureLibraryUpsert",
        output: JSON.stringify({ added: 3, merged: 0 }),
        isError: false,
      });
    });

    const log = screen.getByRole("log", { name: "Literature activity log" });
    expect(
      within(log).getByText(/Agent \(Chat\): saving 3 records to the library/),
    ).toBeTruthy();
    expect(
      within(log).getByText(/Agent saved 3 new \/ 0 merged → papers\/library.json/),
    ).toBeTruthy();
  });

  it("downloads a PDF through the backend and records the local path", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "下载 PDF" }));

    expect(mocks.literatureDownloadPdf).toHaveBeenCalledWith(
      "https://arxiv.org/pdf/1111.00001.pdf",
      "1111.00001.pdf",
    );
    expect(screen.getByText("1 paper · 1 PDF")).toBeTruthy();
    expect(screen.getByRole("button", { name: "已下载 1" })).toBeTruthy();
  });

  it("imports a user-selected PDF into the paper record", async () => {
    useLiteratureStore.setState({ library: fixtureLibrary(), loaded: true });

    await act(async () => {
      await useLiteratureStore.getState().uploadPdf(
        fixturePaper.id,
        "C:/Users/researcher/selected.pdf",
      );
    });

    expect(mocks.literatureImportPdf).toHaveBeenCalledWith(
      "C:/Users/researcher/selected.pdf",
      "1111.00001.pdf",
    );
    expect(useLiteratureStore.getState().library.papers[0].pdf).toMatchObject({
      status: "downloaded",
      path: "papers/1111.00001.pdf",
      bytes: 654321,
    });
  });

  it("uses the configured Review LLM for agent screening", async () => {
    const library = fixtureLibrary();
    library.reviewTasks = [{
      id: "task-review",
      question: "Which papers ground claims?",
      criteria: [{
        id: "criterion-1",
        kind: "include",
        text: "Must discuss grounded claims",
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      searchIds: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      suggestions: [],
    }];
    useLiteratureStore.setState({ library, loaded: true });
    mocks.literatureReviewLlm.mockResolvedValue(JSON.stringify([{
      index: 0,
      decision: "include",
      score: 91,
      confidence: 88,
      rationale: "It directly discusses grounded reading.",
      quote: "A previously saved record loaded from papers/library.json.",
    }]));

    await act(async () => {
      await useLiteratureStore.getState().screenPapersForTask("task-review");
    });

    expect(mocks.literatureReviewLlm).toHaveBeenCalledOnce();
    expect(mocks.literatureLlm).not.toHaveBeenCalled();
    expect(useLiteratureStore.getState().library.papers[0].verdict?.score).toBe(91);
  });

  it("creates and edits a colored PDF annotation", () => {
    useLiteratureStore.setState({ library: fixtureLibrary(), loaded: true });

    act(() => {
      useLiteratureStore.getState().addPdfAnnotation(fixturePaper.id, {
        page: 2,
        quote: "用户标注",
        note: "",
        kind: "note",
        color: "purple",
        rects: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.08 }],
      });
    });
    const annotation = useLiteratureStore.getState().library.papers[0].pdfAnnotations[0];
    act(() => {
      useLiteratureStore.getState().updatePdfAnnotation(fixturePaper.id, annotation.id, {
        quote: "修改后的核心内容",
        note: "修改后的备注",
        color: "green",
      });
    });

    expect(useLiteratureStore.getState().library.papers[0].pdfAnnotations[0]).toMatchObject({
      quote: "修改后的核心内容",
      note: "修改后的备注",
      color: "green",
      kind: "note",
    });
  });

  it("opens an already downloaded PDF in the embedded reader", async () => {
    const user = userEvent.setup();
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getAllByRole("button", { name: "打开 PDF" })[0]);

    // Opening a downloaded PDF takes over the body with the immersive reading
    // shell (full-width reader + a back button), not the cramped side panel.
    expect(screen.getByRole("button", { name: "‹ 返回" })).toBeTruthy();
    expect(mocks.literaturePdfOpen).not.toHaveBeenCalled();
    expect(mocks.literatureDownloadPdf).not.toHaveBeenCalled();
  });

  it("runs a remote search and persists it as a saved search", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.type(screen.getByLabelText("远程文献检索"), "grounded agents");
    await user.click(screen.getByRole("button", { name: "检索并保存" }));

    await waitFor(() =>
      expect(mocks.literatureSearch).toHaveBeenCalledWith(
        "grounded agents",
        ["arxiv", "crossref", "openalex"],
        20,
      ),
    );
    expect(mocks.literatureLibraryUpsert).toHaveBeenCalled();
  });

  it("creates and edits a review task from the visible workflow panel", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "新建审查" }));
    await user.type(screen.getByLabelText("审查问题"), "Which agents ground claims?");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    expect(await screen.findByLabelText("当前审查问题")).toBeTruthy();
    expect(screen.getByRole("button", { name: "按标准筛选论文" })).toBeTruthy();
  });

  it("hands papers without a direct PDF link to Playwright MCP", async () => {
    const user = userEvent.setup();
    const withoutDirectPdf = fixtureLibrary();
    withoutDirectPdf.papers[0].pdf = { status: "none" };
    mocks.literatureLoad.mockResolvedValue(withoutDirectPdf);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "下载 PDF" }));

    expect(mocks.literatureDownloadPdf).not.toHaveBeenCalled();
    expect(useStore.getState().pendingChatInput).toContain("Playwright MCP");
    expect(useStore.getState().pendingChatInput).toContain("arxiv:1111.00001");
    expect(useStore.getState().tab).toBe("chat");
  });

  it("deletes a paper from the library after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(screen.getByText("论文库为空。")).toBeTruthy();
    await waitFor(() => expect(mocks.literatureSave).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const saved = mocks.literatureSave.mock.calls[
      mocks.literatureSave.mock.calls.length - 1
    ]?.[0] as LiteratureLibrary;
    expect(saved.papers).toHaveLength(0);
  });

  it("opens Chat from the selected paper detail", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "问 Agent" }));

    expect(useStore.getState().pendingChatInput).toBe(
      '/research-lit "Persisted Paper on Grounded Reading"',
    );
    expect(useStore.getState().tab).toBe("chat");
  });

  it("reloads the library after a chat turn ends (skill upserts land)", async () => {
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    expect(mocks.literatureLoad).toHaveBeenCalledTimes(1);

    const updated = fixtureLibrary();
    updated.papers[0].title = "Persisted Paper on Grounded Reading (v2)";
    mocks.literatureLoad.mockResolvedValue(updated);
    await act(async () => {
      chatDoneHandler?.("done");
    });

    await waitFor(() =>
      expect(mocks.literatureLoad).toHaveBeenCalledTimes(2),
    );
    expect(
      (await screen.findAllByText("Persisted Paper on Grounded Reading (v2)")).length,
    ).toBeGreaterThan(0);
  });

  it("reloads from disk when the Literature view is opened again", async () => {
    const first = render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    first.unmount();

    const updated = fixtureLibrary();
    updated.papers[0].title = "Persisted Paper on Grounded Reading (fresh)";
    mocks.literatureLoad.mockResolvedValue(updated);
    render(<Literature />);

    await waitFor(() => expect(mocks.literatureLoad).toHaveBeenCalledTimes(2));
    expect(
      (await screen.findAllByText("Persisted Paper on Grounded Reading (fresh)")).length,
    ).toBeGreaterThan(0);
  });

  it("does not silently fall back to the abstract when full-text extraction fails", async () => {
    const user = userEvent.setup();
    const downloaded = fixtureLibrary();
    downloaded.papers[0].abstract =
      "Screening is hard. We propose a staged pipeline for triage. It reaches 0.94 recall at 8x less reading time. A limitation is the CS-only evaluation.";
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    downloaded.projectFocus = {
      question: "agent screening of literature",
      motivation: "",
      scope: "screening, triage",
      currentAssumptions: "",
    };
    mocks.literatureLoad.mockResolvedValue(downloaded);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "从完整全文生成简报" }));

    expect((await screen.findAllByText(/全文简报生成失败/)).length).toBeGreaterThan(0);
    expect(mocks.literatureLlm).not.toHaveBeenCalled();
    expect(document.querySelector(".lit-brief")).toBeNull();
  });

  it("refuses to present a truncated extraction as a full-text brief", async () => {
    const user = userEvent.setup();
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    mocks.literaturePdfText.mockResolvedValue({
      text: "Partial text",
      pages: [{ page: 1, text: "Partial text", source: "embedded" }],
      totalCharacters: 300000,
      extractedCharacters: 200000,
      truncated: true,
      ocrUsed: false,
      missingPages: [2],
      warnings: [],
    });

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "从完整全文生成简报" }));

    expect((await screen.findAllByText(/PDF 全文不完整/)).length).toBeGreaterThan(0);
    expect(mocks.literatureLlm).not.toHaveBeenCalled();
  });

  it("writes the brief with the real LLM when an executor is configured", async () => {
    const user = userEvent.setup();
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    mocks.literaturePdfText.mockResolvedValue({
      text: "[[PAGE 1]]\nComplete paper text with methods, results, and limitations.",
      pages: [{
        page: 1,
        text: "Complete paper text with methods, results, and limitations.",
        source: "embedded",
      }],
      totalCharacters: 59,
      extractedCharacters: 59,
      truncated: false,
      ocrUsed: false,
      missingPages: [],
      warnings: [],
    });
    mocks.literatureLlm.mockResolvedValue(
      JSON.stringify({
        problem: {
          text: "Reviewers drown in papers.",
          page: 1,
          quote: "Complete paper text with methods, results, and limitations.",
        },
        method: {
          text: "A staged agentic pipeline.",
          page: 1,
          quote: "Complete paper text with methods, results, and limitations.",
        },
        results: {
          text: "Reaches 0.94 recall at 8x less reading.",
          page: 1,
          quote: "Complete paper text with methods, results, and limitations.",
        },
        limits: {
          text: "Evaluated on CS corpora only.",
          page: 1,
          quote: "Complete paper text with methods, results, and limitations.",
        },
        forYou: {
          text: "Direct precedent for your screening queue.",
          page: 1,
          quote: "Complete paper text with methods, results, and limitations.",
        },
      }),
    );
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "从完整全文生成简报" }));

    expect(await screen.findByText("Reviewers drown in papers.")).toBeTruthy();
    const detail = document.querySelector(".lit-brief") as HTMLElement;
    expect(within(detail).getByText("A staged agentic pipeline.")).toBeTruthy();
    expect(mocks.literatureLlm).toHaveBeenCalled();
    expect(within(detail).getAllByText("[pdf p.1]").length).toBe(5);
    expect(useLiteratureStore.getState().library.papers[0].pdfAnnotations).toHaveLength(5);
  });

  it("rejects brief page anchors that are not present in the extracted PDF", async () => {
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    mocks.literaturePdfText.mockResolvedValue({
      text: "[[PAGE 1]]\nOnly page one is available.",
      pages: [{ page: 1, text: "Only page one is available.", source: "embedded" }],
      totalCharacters: 27,
      extractedCharacters: 27,
      truncated: false,
      ocrUsed: false,
      missingPages: [],
      warnings: [],
    });
    mocks.literatureLlm.mockResolvedValue(
      JSON.stringify({
        problem: { text: "Unsupported page.", page: 99 },
        method: { text: "Unsupported page.", page: 99 },
        results: { text: "Unsupported page.", page: 99 },
        limits: { text: "Unsupported page.", page: 99 },
        forYou: { text: "Unsupported page.", page: 99 },
      }),
    );

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await act(async () => {
      await useLiteratureStore.getState().generateBrief(downloaded.papers[0].id);
    });

    expect(useLiteratureStore.getState().library.papers[0].brief).toBeUndefined();
    expect(useLiteratureStore.getState().error).toContain("valid PDF page anchor");
  });

  it("saves only visual evidence tied to supplied page images", async () => {
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    mocks.literaturePdfImages.mockResolvedValue({
      pages: [{
        page: 1,
        mimeType: "image/jpeg",
        data: "ZmFrZQ==",
        byteLength: 4,
        fingerprint: "sha256:page-1",
      }],
      totalPages: 1,
      totalBytes: 4,
    });
    mocks.literatureLlmVision.mockResolvedValue(
      JSON.stringify([
        {
          page: 1,
          quote: "Exact grounded evidence appears here.",
          note: "Visible on the rendered page.",
          role: "result",
        },
        { page: 99, quote: "Wrong page evidence.", note: "Invalid.", role: "result" },
      ]),
    );
    mocks.literatureLlm.mockResolvedValue("[]");

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await act(async () => {
      await useLiteratureStore.getState().generateAnswerChains(downloaded.papers[0].id);
    });

    expect(useLiteratureStore.getState().library.papers[0].evidence).toEqual([
      expect.objectContaining({
        page: 1,
        quote: "Exact grounded evidence appears here.",
        source: "vision",
        imageFingerprint: "sha256:page-1",
      }),
    ]);
    expect(mocks.literatureLlmVision).toHaveBeenCalledTimes(1);
    expect(mocks.literatureLlmVision.mock.calls[0][0]).toContain(
      "Write every evidence explanation in Chinese",
    );
    expect(mocks.literatureLlmVision.mock.calls[0][1]).toContain(
      "Write every note in Chinese",
    );
  });

  it("reads every rendered page-image batch before building answer chains", async () => {
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    const pages = Array.from({ length: 5 }, (_, index) => ({
      page: index + 1,
      mimeType: "image/jpeg" as const,
      data: `cGFnZS0${index + 1}=`,
      byteLength: 6,
      fingerprint: `sha256:page-${index + 1}`,
    }));
    mocks.literaturePdfImages.mockResolvedValue({
      pages,
      totalPages: pages.length,
      totalBytes: 30,
    });
    mocks.literatureLlmVision.mockImplementation(
      (_system: string, _prompt: string, batch: typeof pages) =>
        Promise.resolve(JSON.stringify(batch.map((page) => ({
          page: page.page,
          quote: `Visible evidence on page ${page.page}.`,
          note: `Observed page ${page.page}.`,
          role: "result",
        })))),
    );
    mocks.literatureLlm.mockImplementation((_system: string, prompt: string) => {
      const evidenceId = prompt.match(/"id":"([^"]+)"/)?.[1];
      return Promise.resolve(JSON.stringify([{
        question: "What was observed?",
        answer: "The visual reader covered the paper.",
        supports: [{ evidenceId, role: "result" }],
      }]));
    });

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await act(async () => {
      await useLiteratureStore.getState().generateAnswerChains(downloaded.papers[0].id);
    });

    expect(mocks.literatureLlmVision).toHaveBeenCalledTimes(2);
    expect(mocks.literatureLlmVision.mock.calls.flatMap((call) => call[2])).toHaveLength(5);
    expect(mocks.literatureLlm.mock.calls[0][0]).toContain(
      "Write every question and final answer in Chinese",
    );
    expect(mocks.literatureLlm.mock.calls[0][1]).toContain(
      "All question and answer values must be written in Chinese",
    );
  });

  it("builds question-answer chains only from visual evidence ids", async () => {
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    mocks.literaturePdfImages.mockResolvedValue({
      pages: [{
        page: 1,
        mimeType: "image/jpeg",
        data: "ZmFrZQ==",
        byteLength: 4,
        fingerprint: "sha256:page-1",
      }],
      totalPages: 1,
      totalBytes: 4,
    });
    mocks.literatureLlmVision.mockResolvedValue(
      JSON.stringify([
        {
          page: 1,
          quote: "A staged pipeline reaches 0.94 recall.",
          note: "Main quantitative result.",
          role: "result",
        },
      ]),
    );
    mocks.literatureLlm.mockImplementation((_system: string, prompt: string) => {
      const evidenceId = prompt.match(/"id":"([^"]+)"/)?.[1];
      return Promise.resolve(JSON.stringify([
        {
          question: "What is the main result?",
          answer: "The staged pipeline reaches 0.94 recall.",
          supports: [
            { evidenceId, role: "result" },
            { evidenceId: "missing-evidence", role: "result" },
          ],
        },
      ]));
    });

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await act(async () => {
      await useLiteratureStore.getState().generateAnswerChains(downloaded.papers[0].id);
    });

    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.answerChains).toHaveLength(1);
    expect(paper.answerChains[0].basis).toBe("vision");
    expect(paper.answerChains[0].supports).toHaveLength(1);
    expect(paper.pdfAnnotations.filter((item) => item.kind === "answer-support")).toEqual([
      expect.objectContaining({
        kind: "answer-support",
        page: 1,
        quote: "A staged pipeline reaches 0.94 recall.",
        source: "vision",
        imageFingerprint: "sha256:page-1",
        evidenceId: paper.evidence[0].id,
      }),
    ]);

    act(() => {
      useLiteratureStore.getState().updateAnswerChain(paper.id, paper.answerChains[0].id, {
        answer: "A human-revised answer.",
        reviewStatus: "accepted",
      });
    });
    const reviewed = useLiteratureStore.getState().library.papers[0];
    expect(reviewed.answerChains[0].reviewStatus).toBe("accepted");
    expect(
      reviewed.pdfAnnotations.find((item) => item.kind === "answer-support")?.note,
    ).toContain("A human-revised answer.");
  });

  it("deletes evidence and removes its linked answer-chain support", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers[0].evidence = [{
      id: "evidence-1",
      page: 3,
      quote: "The visual result reaches 0.94 recall.",
      note: "结果：主要定量结果。",
      source: "vision",
      imageFingerprint: "sha256:page-3",
    }];
    library.papers[0].answerChains = [{
      id: "chain-1",
      question: "主要结果是什么？",
      answer: "该方法达到 0.94 召回率。",
      supports: [{ annotationId: "support-1", role: "result" }],
      basis: "vision",
      reviewStatus: "unreviewed",
      createdAt: "2026-06-01T00:00:00.000Z",
    }];
    library.papers[0].pdfAnnotations = [
      {
        id: "evidence-mark-1",
        page: 3,
        quote: "The visual result reaches 0.94 recall.",
        note: "结果：主要定量结果。",
        kind: "evidence",
        source: "vision",
        imageFingerprint: "sha256:page-3",
        sourceId: "evidence-1",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "support-1",
        page: 3,
        quote: "The visual result reaches 0.94 recall.",
        note: "结果：该方法达到 0.94 召回率。",
        kind: "answer-support",
        source: "vision",
        imageFingerprint: "sha256:page-3",
        sourceId: "chain-1",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    ];
    mocks.literatureLoad.mockResolvedValue(library);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("tab", { name: "证据" }));
    expect(
      screen.getByRole("heading", { name: "从中文结论回到 PDF 原始证据" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "问答结论" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "原文证据" })).toBeTruthy();
    expect(screen.queryByLabelText("问题 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "编辑问题 1" }));
    expect(screen.getByLabelText("问题 1").tagName).toBe("TEXTAREA");
    await user.tab();
    expect(screen.getByText("中文说明")).toBeTruthy();
    expect(screen.getAllByText("原文摘录").length).toBeGreaterThan(0);
    await user.click(await screen.findByRole("button", { name: /删除证据/ }));

    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.evidence).toEqual([]);
    expect(paper.answerChains).toEqual([]);
    expect(paper.pdfAnnotations).toEqual([]);
    const activity = useLiteratureStore.getState().activity;
    expect(activity[activity.length - 1]?.text).toContain("已删除第 3 页证据");
  });

  it("batch-moves selected papers along the pipeline", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(
      screen.getByLabelText("Select Persisted Paper on Grounded Reading"),
    );
    const batchBar = screen.getByRole("toolbar", { name: "Batch actions" });
    await user.click(within(batchBar).getByRole("button", { name: "候选" }));

    expect(screen.getByRole("button", { name: "候选 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收件箱 0" })).toBeTruthy();
  });
});
