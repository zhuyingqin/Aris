// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiteratureLibrary, LiteraturePaper } from "../literatureTypes";

const mocks = vi.hoisted(() => ({
  literatureLoad: vi.fn(),
  literatureStorageStatus: vi.fn(),
  literatureStorageBackup: vi.fn(),
  literatureFullTextSearch: vi.fn(),
  literatureDuplicateCandidates: vi.fn(),
  literatureMergeDuplicates: vi.fn(),
  literatureImportPdfAsRecord: vi.fn(),
  literatureApplyDelta: vi.fn(),
  literatureSave: vi.fn(),
  literatureSearch: vi.fn(),
  literatureProtocolCreate: vi.fn(),
  literatureProtocolPreview: vi.fn(),
  literatureProtocolExecute: vi.fn(),
  onLiteratureSearchProgress: vi.fn(),
  literatureLibraryUpsert: vi.fn(),
  literatureDownloadPdf: vi.fn(),
  literatureImportPdf: vi.fn(),
  literatureImportAttachment: vi.fn(),
  literatureAttachmentOpen: vi.fn(),
  literatureExportBibliography: vi.fn(),
  literatureWriteBibliographyExport: vi.fn(),
  literatureReadAnnotationExport: vi.fn(),
  literatureWriteAnnotationExport: vi.fn(),
  literatureLlm: vi.fn(),
  literatureReviewLlm: vi.fn(),
  literatureLlmVision: vi.fn(),
  literaturePdfOpen: vi.fn(),
  literaturePdfText: vi.fn(),
  literaturePdfImages: vi.fn(),
  literaturePdfBytes: vi.fn(),
  knowledgeLoad: vi.fn(),
  knowledgeSearch: vi.fn(),
  knowledgeUpsert: vi.fn(),
  knowledgeConfirm: vi.fn(),
  knowledgeReject: vi.fn(),
  knowledgeGenerate: vi.fn(),
  chatRunCommand: vi.fn(),
  literatureAgentSend: vi.fn(),
  onChatDone: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolResult: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  isTauri: () => true,
  literatureLoad: mocks.literatureLoad,
  literatureStorageStatus: mocks.literatureStorageStatus,
  literatureStorageBackup: mocks.literatureStorageBackup,
  literatureFullTextSearch: mocks.literatureFullTextSearch,
  literatureDuplicateCandidates: mocks.literatureDuplicateCandidates,
  literatureMergeDuplicates: mocks.literatureMergeDuplicates,
  literatureImportPdfAsRecord: mocks.literatureImportPdfAsRecord,
  literatureApplyDelta: mocks.literatureApplyDelta,
  literatureSave: mocks.literatureSave,
  literatureSearch: mocks.literatureSearch,
  literatureProtocolCreate: mocks.literatureProtocolCreate,
  literatureProtocolPreview: mocks.literatureProtocolPreview,
  literatureProtocolExecute: mocks.literatureProtocolExecute,
  onLiteratureSearchProgress: mocks.onLiteratureSearchProgress,
  literatureLibraryUpsert: mocks.literatureLibraryUpsert,
  literatureDownloadPdf: mocks.literatureDownloadPdf,
  literatureImportPdf: mocks.literatureImportPdf,
  literatureImportAttachment: mocks.literatureImportAttachment,
  literatureAttachmentOpen: mocks.literatureAttachmentOpen,
  literatureExportBibliography: mocks.literatureExportBibliography,
  literatureWriteBibliographyExport: mocks.literatureWriteBibliographyExport,
  literatureReadAnnotationExport: mocks.literatureReadAnnotationExport,
  literatureWriteAnnotationExport: mocks.literatureWriteAnnotationExport,
  literatureLlm: mocks.literatureLlm,
  literatureReviewLlm: mocks.literatureReviewLlm,
  literatureLlmVision: mocks.literatureLlmVision,
  literaturePdfOpen: mocks.literaturePdfOpen,
  literaturePdfText: mocks.literaturePdfText,
  literaturePdfBytes: mocks.literaturePdfBytes,
  knowledgeLoad: mocks.knowledgeLoad,
  knowledgeSearch: mocks.knowledgeSearch,
  knowledgeUpsert: mocks.knowledgeUpsert,
  knowledgeConfirm: mocks.knowledgeConfirm,
  knowledgeReject: mocks.knowledgeReject,
  knowledgeGenerate: mocks.knowledgeGenerate,
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

vi.mock("../pdfExtraction", () => ({
  extractPdfTextByPage: mocks.literaturePdfText,
  extractPdfPageImages: mocks.literaturePdfImages,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import Literature from "../Literature";
import { resetLiteratureStore, useLiteratureStore } from "../literatureStore";
import { resetKnowledgeStore } from "../../knowledge/knowledgeStore";
import { useStore } from "../../store";

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
  screenRuns: [],
});

beforeEach(() => {
  resetLiteratureStore();
  resetKnowledgeStore();
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
  mocks.literatureStorageStatus.mockReset().mockResolvedValue({
    schemaVersion: 1,
    databasePath: "C:/project/.somniq/literature/literature.sqlite3",
    databaseBytes: 4096,
    canonicalRecordCount: 1,
    searchRunCount: 0,
    health: {
      healthy: true,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      journalMode: "wal",
    },
    latestBackup: null,
    projectionPath: "C:/project/papers/library.json",
    projectionExists: true,
  });
  mocks.literatureStorageBackup.mockReset().mockResolvedValue({
    path: "C:/project/.somniq/literature/backups/literature-1.sqlite3",
    bytes: 4096,
    createdAt: "1784635200000",
  });
  mocks.literatureFullTextSearch.mockReset().mockResolvedValue({ papers: [] });
  mocks.literatureDuplicateCandidates.mockReset().mockResolvedValue([]);
  mocks.literatureMergeDuplicates.mockReset().mockResolvedValue({ primaryRecordId: "arxiv:1111.00001" });
  mocks.literatureImportPdfAsRecord.mockReset().mockResolvedValue({ record: { recordId: "arxiv:1111.00001" } });
  mocks.literatureApplyDelta.mockReset().mockImplementation((delta) => {
    const current = fixtureLibrary();
    const papers = new Map(current.papers.map((paper) => [paper.id, paper]));
    for (const paper of delta.upsertPapers ?? []) papers.set(paper.id, paper);
    for (const id of delta.hidePaperIds ?? []) papers.delete(id);
    return Promise.resolve({
      ...current,
      ...delta.projectionMetadata,
      papers: [...papers.values()],
    });
  });
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
  mocks.literatureProtocolCreate.mockReset().mockResolvedValue({
    protocol: { id: "protocol-reproducible-search" },
  });
  mocks.literatureProtocolPreview.mockReset().mockResolvedValue({
    protocol: {
      id: "protocol-reproducible-search",
      question: "What evidence supports local-first review?",
      scope: "",
      timeWindow: "",
    },
    plan: [{
      source: "crossref",
      query: "local-first review",
      adapterStatus: "available",
      coverageNote: "DOI metadata coverage.",
      quotaPolicy: "Captures exposed rate-limit headers.",
    }],
    defaultMaxResults: 50,
    maximumMaxResults: 100,
  });
  mocks.literatureProtocolExecute.mockReset().mockResolvedValue({
    searchRun: {
      id: "run-reproducible-search",
      status: "completed",
      sourceAttempts: [{
        source: "crossref",
        status: "completed",
        hitCount: 12,
        returnedCount: 5,
      }],
    },
    warnings: [],
    recordPreview: [{
      id: "doi:10.1000/sample",
      title: "Sample record from the reproducible run",
      authors: ["A. Researcher"],
      year: 2026,
      venue: "Journal of Examples",
      source: "crossref",
    }],
  });
  mocks.onLiteratureSearchProgress.mockReset().mockResolvedValue(() => {});
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
  mocks.literatureImportAttachment.mockReset().mockResolvedValue({
    path: "C:/project/papers/attachments/123-supplement.csv",
    relativePath: "papers/attachments/123-supplement.csv",
    fileName: "supplement.csv",
    bytes: 321,
    mimeType: "text/csv",
  });
  mocks.literatureAttachmentOpen.mockReset().mockResolvedValue(undefined);
  mocks.literatureReadAnnotationExport.mockReset().mockResolvedValue({ annotations: [], notes: [] });
  mocks.literatureWriteAnnotationExport.mockReset().mockResolvedValue(undefined);
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
  mocks.knowledgeLoad.mockReset().mockResolvedValue({ points: [] });
  mocks.knowledgeSearch.mockReset().mockResolvedValue({ results: [] });
  mocks.knowledgeUpsert.mockReset().mockResolvedValue({ ids: [] });
  mocks.knowledgeConfirm.mockReset().mockResolvedValue(undefined);
  mocks.knowledgeReject.mockReset().mockResolvedValue(true);
  mocks.knowledgeGenerate.mockReset().mockResolvedValue({ candidates: [] });
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

async function openSelectedPaperOverview(user: { click: (element: Element) => Promise<void> }) {
  await user.click(screen.getByRole("tab", { name: "简报" }));
}

describe("Literature library", () => {
  it("requires a protocol preview and explicit confirmation before a reproducible search run", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    await user.click(screen.getByRole("tab", { name: "检索" }));
    await user.type(screen.getByRole("textbox", { name: "研究问题" }), "What evidence supports local-first review?");
    await user.type(screen.getByRole("textbox", { name: "完整查询式" }), "local-first review");
    await user.type(screen.getByRole("textbox", { name: "openalex 查询式" }), "openalex-local-first");
    await user.type(screen.getByRole("textbox", { name: "arxiv 查询式" }), "all:arxiv-local-first");
    await user.click(screen.getByRole("button", { name: "生成并预览协议" }));

    expect(await screen.findByText("crossref")).toBeTruthy();
    expect(mocks.literatureProtocolCreate).toHaveBeenCalledWith(expect.objectContaining({
      question: "What evidence supports local-first review?",
      databases: ["openalex", "crossref", "semantic-scholar", "arxiv"],
      queries: {
        openalex: "openalex-local-first",
        crossref: "local-first review",
        "semantic-scholar": "local-first review",
        arxiv: "all:arxiv-local-first",
      },
    }));
    expect(mocks.literatureProtocolPreview).toHaveBeenCalledWith("protocol-reproducible-search");
    expect((screen.getByRole("button", { name: "执行已确认检索" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: /我已核对查询式/ }));
    await user.click(screen.getByRole("button", { name: "执行已确认检索" }));

    expect(mocks.literatureProtocolExecute).toHaveBeenCalledWith(
      "protocol-reproducible-search",
      "execute",
      20,
      undefined,
    );
    expect(await screen.findByText(/SearchRun run-reproducible-search/)).toBeTruthy();
    expect(screen.getByText(/Sample record from the reproducible run/)).toBeTruthy();
  });

  it("keeps the reference manager as the default view and exposes the canonical SQLite store", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    expect(await screen.findAllByText("Persisted Paper on Grounded Reading")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
    expect(await screen.findByText(/本地 SQLite · 模式 v1 · 健康 · 1 条规范记录 · 4 KB · 尚未备份/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "备份数据库" }));
    await waitFor(() => expect(mocks.literatureStorageBackup).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("tab", { name: "检索" }));
    expect(screen.getByRole("textbox", { name: "研究问题" })).toBeTruthy();
  });

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
    const user = userEvent.setup();
    const legacy = fixtureLibrary();
    const paper = legacy.papers[0] as Partial<LiteraturePaper>;
    delete paper.abstract;
    delete paper.tags;
    delete paper.evidence;
    delete paper.pdf;
    mocks.literatureLoad.mockResolvedValue(legacy);

    render(<Literature />);

    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await openSelectedPaperOverview(user);
    expect(await screen.findByText("当前元数据源未提供摘要。可尝试重新检索或从论文页面补充元数据。")).toBeTruthy();
    expect(screen.getByText("缺失")).toBeTruthy();
  });

  it("opens the global knowledge graph from the Literature-level switch", async () => {
    const user = userEvent.setup();
    const withEvidence = fixtureLibrary();
    withEvidence.papers[0].evidence = [{
      id: "ev-graph",
      page: 2,
      quote: "grounded graph quote",
      note: "Global graph evidence node.",
      source: "text",
    }];
    mocks.literatureLoad.mockResolvedValue(withEvidence);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    expect(screen.queryByText("Literature Workflow")).toBeNull();
    expect(screen.queryByText("Screen, understand, and convert papers into evidence.")).toBeNull();
    expect(screen.queryByRole("tab", { name: "知识库" })).toBeNull();
    expect(screen.getByRole("tab", { name: "知识图谱" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "知识图谱" }));

    const graph = await screen.findByLabelText("知识图谱");
    expect(within(graph).queryByText("Global graph evidence node.")).toBeNull();
    expect(screen.queryByRole("button", { name: /生成知识点/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "显示知识节点" }));
    expect(within(graph).getByText("Global graph evidence node.")).toBeTruthy();
    expect(screen.queryByText("Paper Workspace")).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Core review" }));
    expect(screen.getByRole("button", { name: "Core review" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Core review" }));
    expect(screen.getByRole("button", { name: "Core review" }).getAttribute("aria-pressed")).toBe("false");
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
        output: JSON.stringify({ added: 0, merged: 3 }),
        isError: false,
      });
    });

    const log = screen.getByRole("log", { name: "Literature activity log" });
    expect(
      within(log).getByText(/Agent \(Chat\): refreshing the projection for 3 canonical records/),
    ).toBeTruthy();
    expect(
      within(log).getByText(/Agent refreshed the local literature database for 3 canonical records/),
    ).toBeTruthy();
  });

  it("rejects malformed and duplicate citation keys before mutating metadata", () => {
    const library = fixtureLibrary();
    const second = structuredClone(fixturePaper);
    second.id = "second-paper";
    second.title = "Second local record";
    second.citationKey = "other2025";
    library.papers[0].citationKey = "first2025";
    library.papers.push(second);
    useLiteratureStore.setState({ library, loaded: true, error: null });

    act(() => {
      useLiteratureStore.getState().updatePaperMetadata(fixturePaper.id, { citationKey: "not a key" });
    });
    expect(useLiteratureStore.getState().library.papers[0]?.citationKey).toBe("first2025");
    expect(useLiteratureStore.getState().error).toContain("Citation key");

    act(() => {
      useLiteratureStore.getState().updatePaperMetadata(fixturePaper.id, { citationKey: "OTHER2025" });
    });
    expect(useLiteratureStore.getState().library.papers[0]?.citationKey).toBe("first2025");
    expect(useLiteratureStore.getState().error).toContain("Citation key");

    act(() => {
      useLiteratureStore.getState().updatePaperMetadata(fixturePaper.id, { citationKey: "first2026" });
    });
    expect(useLiteratureStore.getState().library.papers[0]?.citationKey).toBe("first2026");
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
    expect(useLiteratureStore.getState().library.papers[0].screenings?.["task-review"]?.method)
      .toBe("review-llm");
    expect(useLiteratureStore.getState().library.screenRuns[0]).toMatchObject({
      taskId: "task-review",
      status: "completed",
      chunkSize: 40,
      totalPapers: 1,
      reviewerCount: 1,
      fallbackCount: 0,
    });
    expect(mocks.literatureApplyDelta.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("screens large libraries in stable 40-paper chunks", async () => {
    const library = fixtureLibrary();
    library.papers = Array.from({ length: 41 }, (_, index) => ({
      ...structuredClone(fixturePaper),
      id: `arxiv:chunk-${index}`,
      title: `Chunk paper ${index}`,
      abstract: `Grounded literature screening evidence for paper ${index}.`,
    }));
    library.reviewTasks = [{
      id: "task-chunks",
      question: "Which papers discuss grounded literature screening?",
      criteria: [],
      searchIds: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      suggestions: [],
    }];
    useLiteratureStore.setState({ library, loaded: true });
    const reply = (count: number) => JSON.stringify(Array.from({ length: count }, (_, index) => ({
      index,
      decision: "include",
      score: 80,
      confidence: 85,
      rationale: "Matches the review question.",
      quote: `Grounded literature screening evidence for paper ${index}.`,
    })));
    mocks.literatureReviewLlm
      .mockResolvedValueOnce(reply(40))
      .mockResolvedValueOnce(reply(1));

    await act(async () => {
      await useLiteratureStore.getState().screenPapersForTask("task-chunks");
    });

    const run = useLiteratureStore.getState().library.screenRuns[0];
    expect(mocks.literatureReviewLlm).toHaveBeenCalledTimes(2);
    expect(run.chunks.map((chunk) => chunk.expectedCount)).toEqual([40, 1]);
    expect(run.chunks.map((chunk) => chunk.status)).toEqual(["completed", "completed"]);
    expect(run).toMatchObject({ status: "completed", reviewerCount: 41, fallbackCount: 0 });
  });

  it("records omitted Reviewer rows and labels heuristic fallback", async () => {
    const library = fixtureLibrary();
    library.papers.push({
      ...structuredClone(fixturePaper),
      id: "arxiv:missing-row",
      title: "Paper omitted by the Reviewer",
    });
    library.reviewTasks = [{
      id: "task-partial",
      question: "Which papers ground claims?",
      criteria: [],
      searchIds: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      suggestions: [],
    }];
    useLiteratureStore.setState({ library, loaded: true });
    mocks.literatureReviewLlm.mockResolvedValue(JSON.stringify([{
      index: 0,
      decision: "include",
      score: 82,
      confidence: 80,
      rationale: "Matches.",
      quote: "A previously saved record loaded from papers/library.json.",
    }]));

    await act(async () => {
      await useLiteratureStore.getState().screenPapersForTask("task-partial");
    });

    const state = useLiteratureStore.getState().library;
    expect(state.screenRuns[0]).toMatchObject({
      status: "partial",
      reviewerCount: 1,
      fallbackCount: 1,
    });
    expect(state.screenRuns[0].chunks[0].missingIndices).toEqual([1]);
    expect(state.papers[1].screenings?.["task-partial"]?.method).toBe("heuristic");
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

  it("keeps a note generated from a PDF annotation after the highlight is removed", () => {
    useLiteratureStore.setState({ library: fixtureLibrary(), loaded: true });
    const state = useLiteratureStore.getState();
    act(() => {
      state.addPdfAnnotation(fixturePaper.id, {
        page: 4,
        quote: "A stable reader anchor.",
        note: "Interpret this result carefully.",
        kind: "note",
      });
    });
    const annotation = useLiteratureStore.getState().library.papers[0].pdfAnnotations[0];

    act(() => {
      useLiteratureStore.getState().createNoteFromAnnotation(fixturePaper.id, annotation.id);
    });
    const created = useLiteratureStore.getState().library.papers[0].notes?.[0];
    expect(created).toMatchObject({ annotationId: annotation.id, source: "annotation" });
    expect(created?.content).toContain("A stable reader anchor.");

    act(() => {
      useLiteratureStore.getState().deletePdfAnnotation(fixturePaper.id, annotation.id);
    });
    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.pdfAnnotations).toEqual([]);
    expect(paper.notes?.[0]).toMatchObject({ content: expect.stringContaining("Interpret this result carefully.") });
    expect(paper.notes?.[0]?.annotationId).toBeUndefined();
  });

  it("imports supplemental attachments and portable annotation JSON without replacing reader data", async () => {
    useLiteratureStore.setState({ library: fixtureLibrary(), loaded: true });

    await act(async () => {
      await useLiteratureStore.getState().importAttachment(
        fixturePaper.id,
        "C:/Users/researcher/supplement.csv",
        "supplement",
      );
    });
    expect(mocks.literatureImportAttachment).toHaveBeenCalledWith("C:/Users/researcher/supplement.csv");
    expect(useLiteratureStore.getState().library.papers[0].attachments).toEqual([
      expect.objectContaining({ kind: "supplement", path: "papers/attachments/123-supplement.csv" }),
    ]);

    let imported: { annotations: number; notes: number } | undefined;
    act(() => {
      imported = useLiteratureStore.getState().importAnnotations(fixturePaper.id, {
        annotations: [{ id: "portable-mark", page: 2, quote: "Imported support", note: "Portable annotation", kind: "note" }],
        notes: [{ title: "Imported note", content: "Keep the provenance.", annotationId: "portable-mark", source: "annotation" }],
      });
    });
    expect(imported).toEqual({ annotations: 1, notes: 1 });
    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.pdfAnnotations).toEqual([expect.objectContaining({ quote: "Imported support" })]);
    expect(paper.notes).toEqual([
      expect.objectContaining({ title: "Imported note", annotationId: "portable-mark", source: "imported" }),
    ]);
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
    expect(screen.getByRole("button", { name: "返回" })).toBeTruthy();
    expect(mocks.literaturePdfOpen).not.toHaveBeenCalled();
    expect(mocks.literatureDownloadPdf).not.toHaveBeenCalled();
  });

  it("opens the first review task and binds it to an explicit saved search", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.searches = [{
      id: "search-run:run-first",
      query: "local-first review",
      sources: ["openalex"],
      ranAt: "2026-06-01T00:00:00.000Z",
      resultCount: 1,
      newCount: 0,
    }];
    library.papers[0].searchIds = ["search-run:run-first"];
    mocks.literatureLoad.mockResolvedValue(library);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    expect(screen.queryByLabelText("远程文献检索")).toBeNull();
    expect(screen.queryByRole("button", { name: "检索并保存" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "新建审查任务" }));
    await user.type(screen.getByRole("textbox", { name: "审查问题" }), "Which papers are in this run?");
    await user.selectOptions(screen.getByRole("combobox", { name: "审查范围" }), "search-run:run-first");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    expect(useLiteratureStore.getState().library.reviewTasks[0].searchIds).toEqual([
      "search-run:run-first",
    ]);
    expect(screen.getByRole("textbox", { name: "当前审查问题" })).toBeTruthy();
    expect(mocks.literatureSearch).not.toHaveBeenCalled();
    expect(mocks.literatureLibraryUpsert).not.toHaveBeenCalled();
  });

  it("does not let the retired instant-search store path bypass SearchRun", async () => {
    await act(async () => {
      await useLiteratureStore.getState().runRemoteSearch("local-first review", ["crossref"]);
    });

    expect(useLiteratureStore.getState().error).toMatch(/可复现检索/);
    expect(mocks.literatureSearch).not.toHaveBeenCalled();
    expect(mocks.literatureLibraryUpsert).not.toHaveBeenCalled();
  });

  it("opens and edits a review task from the sidebar workflow panel", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.reviewTasks = [{
      id: "task-review",
      question: "Which agents ground claims?",
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
    mocks.literatureLoad.mockResolvedValue(library);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: /Which agents ground claims/ }));

    const question = await screen.findByLabelText("当前审查问题");
    await user.clear(question);
    await user.type(question, "Which agents ground claims visually?");

    expect((question as HTMLInputElement).value).toBe("Which agents ground claims visually?");
    expect(screen.getByRole("button", { name: "按标准筛选论文" })).toBeTruthy();
  });

  it("hands papers without a direct PDF link to Playwright MCP", async () => {
    const user = userEvent.setup();
    const withoutDirectPdf = fixtureLibrary();
    withoutDirectPdf.papers[0].pdf = { status: "none" };
    mocks.literatureLoad.mockResolvedValue(withoutDirectPdf);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "获取 PDF" }));

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
    await waitFor(() => expect(mocks.literatureApplyDelta).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const saved = mocks.literatureApplyDelta.mock.calls[
      mocks.literatureApplyDelta.mock.calls.length - 1
    ]?.[0] as { hidePaperIds: string[] };
    expect(saved.hidePaperIds).toEqual(["arxiv:1111.00001"]);
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
    await openSelectedPaperOverview(user);
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
    await openSelectedPaperOverview(user);
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
    await openSelectedPaperOverview(user);
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
    // Sparse page text (below the text-evidence floor) routes this page to
    // the vision path, keeping this test's original all-visual intent.
    mocks.literaturePdfText.mockResolvedValue({
      text: "[[PAGE 1]]\nfig",
      pages: [{ page: 1, text: "fig", source: "embedded" }],
      totalCharacters: 3,
      extractedCharacters: 3,
      truncated: false,
      ocrUsed: false,
      missingPages: [],
      warnings: [],
    });
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
    // All 5 pages are sparse (below the text-evidence floor), so every page
    // still routes to the vision path — this test's original intent.
    mocks.literaturePdfText.mockResolvedValue({
      text: Array.from({ length: 5 }, (_, index) => `[[PAGE ${index + 1}]]\nfig`).join("\n\n"),
      pages: Array.from({ length: 5 }, (_, index) => ({
        page: index + 1,
        text: "fig",
        source: "embedded" as const,
      })),
      totalCharacters: 15,
      extractedCharacters: 15,
      truncated: false,
      ocrUsed: false,
      missingPages: [],
      warnings: [],
    });
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
    // Sparse page text (below the text-evidence floor) routes this page to
    // the vision path, keeping this test's original all-visual intent.
    mocks.literaturePdfText.mockResolvedValue({
      text: "[[PAGE 1]]\nfig",
      pages: [{ page: 1, text: "fig", source: "embedded" }],
      totalCharacters: 3,
      extractedCharacters: 3,
      truncated: false,
      ocrUsed: false,
      missingPages: [],
      warnings: [],
    });
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

  it("reads evidence from page text without calling the vision model when pages have readable text", async () => {
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    const bodyText = "A".repeat(500);
    mocks.literaturePdfText.mockResolvedValue({
      text: `[[PAGE 1]]\n${bodyText}`,
      pages: [{ page: 1, text: bodyText, source: "embedded" }],
      totalCharacters: bodyText.length,
      extractedCharacters: bodyText.length,
      truncated: false,
      ocrUsed: false,
      missingPages: [],
      warnings: [],
    });
    mocks.literatureLlm.mockImplementation((_system: string, prompt: string) => {
      if (prompt.includes("[[PAGE 1]]")) {
        return Promise.resolve(JSON.stringify([
          { page: 1, quote: bodyText.slice(0, 20), note: "Found in body text.", role: "result" },
        ]));
      }
      const evidenceId = prompt.match(/"id":"([^"]+)"/)?.[1];
      return Promise.resolve(JSON.stringify([{
        question: "What was found?",
        answer: "The body text covers it.",
        supports: [{ evidenceId, role: "result" }],
      }]));
    });

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await act(async () => {
      await useLiteratureStore.getState().generateAnswerChains(downloaded.papers[0].id);
    });

    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.evidence).toEqual([expect.objectContaining({ page: 1, source: "text" })]);
    expect(paper.answerChains[0].basis).toBe("text");
    expect(mocks.literatureLlmVision).not.toHaveBeenCalled();
    expect(mocks.literaturePdfImages).not.toHaveBeenCalled();
  });

  it("merges text and vision evidence when a paper has both dense text pages and sparse figure pages", async () => {
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    const bodyText = "B".repeat(500);
    mocks.literaturePdfText.mockResolvedValue({
      text: `[[PAGE 1]]\n${bodyText}\n\n[[PAGE 2]]\nfig`,
      pages: [
        { page: 1, text: bodyText, source: "embedded" },
        { page: 2, text: "fig", source: "embedded" },
      ],
      totalCharacters: bodyText.length + 3,
      extractedCharacters: bodyText.length + 3,
      truncated: false,
      ocrUsed: false,
      missingPages: [],
      warnings: [],
    });
    mocks.literaturePdfImages.mockResolvedValue({
      pages: [{
        page: 2,
        mimeType: "image/jpeg",
        data: "ZmFrZQ==",
        byteLength: 4,
        fingerprint: "sha256:page-2",
      }],
      totalPages: 2,
      totalBytes: 4,
    });
    mocks.literatureLlmVision.mockResolvedValue(
      JSON.stringify([{ page: 2, quote: "Chart evidence.", note: "Seen in the figure.", role: "result" }]),
    );
    mocks.literatureLlm.mockImplementation((_system: string, prompt: string) => {
      if (prompt.includes("[[PAGE 1]]")) {
        return Promise.resolve(JSON.stringify([
          { page: 1, quote: bodyText.slice(0, 20), note: "Body text claim.", role: "premise" },
        ]));
      }
      const evidenceIds = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]);
      return Promise.resolve(JSON.stringify([{
        question: "What does the paper show?",
        answer: "Text and figure evidence agree.",
        supports: evidenceIds.map((evidenceId) => ({ evidenceId, role: "result" })),
      }]));
    });

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await act(async () => {
      await useLiteratureStore.getState().generateAnswerChains(downloaded.papers[0].id);
    });

    expect(mocks.literaturePdfImages).toHaveBeenCalledWith("papers/1111.00001.pdf", [2]);
    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.evidence.map((item) => item.source).sort()).toEqual(["text", "vision"]);
    expect(paper.answerChains[0].basis).toBe("vision");
  });

  it("falls back to reading every page visually when full-text extraction fails", async () => {
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);
    mocks.literaturePdfText.mockRejectedValue(new Error("PDF 没有可读取文本。"));
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
      JSON.stringify([{ page: 1, quote: "Scanned page evidence.", note: "Read visually.", role: "result" }]),
    );
    mocks.literatureLlm.mockResolvedValue("[]");

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await act(async () => {
      await useLiteratureStore.getState().generateAnswerChains(downloaded.papers[0].id);
    });

    expect(mocks.literaturePdfImages).toHaveBeenCalledWith("papers/1111.00001.pdf", undefined);
    expect(useLiteratureStore.getState().library.papers[0].evidence).toEqual([
      expect.objectContaining({ page: 1, source: "vision" }),
    ]);
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
