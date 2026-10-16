// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiteratureLibrary, LiteraturePaper } from "../literatureTypes";

const mocks = vi.hoisted(() => ({
  literatureLoad: vi.fn(),
  literatureLibraryModel: vi.fn(),
  literatureStorageStatus: vi.fn(),
  literatureStorageBackup: vi.fn(),
  literatureFullTextSearch: vi.fn(),
  literatureSearchProtocolCreate: vi.fn(),
  literatureSearchProtocolPreview: vi.fn(),
  literatureSearchProtocolExecute: vi.fn(),
  literatureSearchCancel: vi.fn(),
  listenLiteratureSearchProgress: vi.fn(),
  literatureDuplicateCandidates: vi.fn(),
  literatureMergeDuplicates: vi.fn(),
  literatureImportPdfAsRecord: vi.fn(),
  literatureApplyDelta: vi.fn(),
  literatureRestoreItems: vi.fn(),
  literatureUpdateCollections: vi.fn(),
  literatureUpdateItem: vi.fn(),
  literatureCreateItem: vi.fn(),
  literatureUpdateRelations: vi.fn(),
  literatureDownloadPdf: vi.fn(),
  literatureImportPdf: vi.fn(),
  literatureImportAttachment: vi.fn(),
  literatureAttachmentOpen: vi.fn(),
  literatureAttachmentOpenExternal: vi.fn(),
  literatureAttachmentStatus: vi.fn(),
  literatureAttachmentReadText: vi.fn(),
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
  literatureRagIndexPdf: vi.fn(),
  literatureRagIndexLibrary: vi.fn(),
  literatureRagStatus: vi.fn(),
  literatureRagCards: vi.fn(),
  literatureRagSearch: vi.fn(),
  knowledgeRetrievalCardsBuild: vi.fn(),
  projectRagSearch: vi.fn(),
  projectRagAnswer: vi.fn(),
  chatRunCommand: vi.fn(),
  onChatDone: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolResult: vi.fn(),
  onChatModelRetry: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  isTauri: () => true,
  literatureLoad: mocks.literatureLoad,
  literatureLibraryModel: mocks.literatureLibraryModel,
  literatureStorageStatus: mocks.literatureStorageStatus,
  literatureStorageBackup: mocks.literatureStorageBackup,
  literatureFullTextSearch: mocks.literatureFullTextSearch,
  literatureSearchProtocolCreate: mocks.literatureSearchProtocolCreate,
  literatureSearchProtocolPreview: mocks.literatureSearchProtocolPreview,
  literatureSearchProtocolExecute: mocks.literatureSearchProtocolExecute,
  literatureSearchCancel: mocks.literatureSearchCancel,
  listenLiteratureSearchProgress: mocks.listenLiteratureSearchProgress,
  literatureDuplicateCandidates: mocks.literatureDuplicateCandidates,
  literatureMergeDuplicates: mocks.literatureMergeDuplicates,
  literatureImportPdfAsRecord: mocks.literatureImportPdfAsRecord,
  literatureApplyDelta: mocks.literatureApplyDelta,
  literatureRestoreItems: mocks.literatureRestoreItems,
  literatureUpdateCollections: mocks.literatureUpdateCollections,
  literatureUpdateItem: mocks.literatureUpdateItem,
  literatureCreateItem: mocks.literatureCreateItem,
  literatureUpdateRelations: mocks.literatureUpdateRelations,
  literatureDownloadPdf: mocks.literatureDownloadPdf,
  literatureImportPdf: mocks.literatureImportPdf,
  literatureImportAttachment: mocks.literatureImportAttachment,
  literatureAttachmentOpen: mocks.literatureAttachmentOpen,
  literatureAttachmentOpenExternal: mocks.literatureAttachmentOpenExternal,
  literatureAttachmentStatus: mocks.literatureAttachmentStatus,
  literatureAttachmentReadText: mocks.literatureAttachmentReadText,
  literatureExportBibliography: mocks.literatureExportBibliography,
  literatureWriteBibliographyExport: mocks.literatureWriteBibliographyExport,
  literatureReadAnnotationExport: mocks.literatureReadAnnotationExport,
  literatureWriteAnnotationExport: mocks.literatureWriteAnnotationExport,
  literatureLlm: mocks.literatureLlm,
  literatureReviewLlm: mocks.literatureReviewLlm,
  literatureLlmVision: mocks.literatureLlmVision,
  literaturePdfOpen: mocks.literaturePdfOpen,
  literaturePdfBytes: mocks.literaturePdfBytes,
  literatureRagIndexPdf: mocks.literatureRagIndexPdf,
  literatureRagIndexLibrary: mocks.literatureRagIndexLibrary,
  literatureRagStatus: mocks.literatureRagStatus,
  literatureRagCards: mocks.literatureRagCards,
  literatureRagSearch: mocks.literatureRagSearch,
  knowledgeRetrievalCardsBuild: mocks.knowledgeRetrievalCardsBuild,
  projectRagSearch: mocks.projectRagSearch,
  projectRagAnswer: mocks.projectRagAnswer,
  chatRunCommand: mocks.chatRunCommand,
  onChatDone: mocks.onChatDone,
  onChatTool: mocks.onChatTool,
  onChatToolResult: mocks.onChatToolResult,
  onChatModelRetry: mocks.onChatModelRetry,
  chatModelOptions: () => Promise.resolve({ provider: "test", current: "default-model", options: [] }),
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
import { useStore } from "../../store";

async function openDiscover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "文献视图切换" }));
  await user.click(screen.getByRole("menuitem", { name: "检索" }));
}

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

const fixtureLibraryModel = () => ({
  items: [
    {
      item: {
        id: fixturePaper.id,
        key: "PAPERKEY",
        libraryId: "library",
        itemType: "journalArticle",
        version: 1,
        deleted: false,
        trashed: false,
        dateAdded: fixturePaper.addedAt,
        dateModified: fixturePaper.addedAt,
      },
      fields: { title: fixturePaper.title, publicationTitle: fixturePaper.venue, date: String(fixturePaper.year) },
      creators: fixturePaper.authors.map((name, orderIndex) => ({
        id: `creator-${orderIndex}`,
        creatorType: "author",
        name,
        fieldMode: "oneField",
        orderIndex,
      })),
      tags: [],
      collectionIds: [],
      relations: [],
    },
    {
      item: {
        id: "attachment-1",
        key: "ATTACHMENT",
        libraryId: "library",
        itemType: "attachment",
        parentItemId: fixturePaper.id,
        version: 1,
        deleted: false,
        trashed: false,
        dateAdded: fixturePaper.addedAt,
        dateModified: fixturePaper.addedAt,
      },
      fields: {
        title: "main.pdf",
        path: "papers/main.pdf",
        contentType: "application/pdf",
      },
      creators: [],
      tags: [],
      collectionIds: [],
      relations: [],
    },
  ],
  collections: [],
  tags: [],
  savedSearches: [],
  specialCollections: [],
});

beforeEach(() => {
  localStorage.removeItem("somniq-literature-rag-preferences-v1");
  localStorage.removeItem("somniq-literature-auto-retrieval-cards-v1");
  localStorage.removeItem("somniq-literature-discover-mode-v1");
  localStorage.removeItem("somniq-literature-layout-v1");
  resetLiteratureStore();
  useStore.setState({
    language: "cn",
    languagePreferenceSet: true,
    tab: "literature",
    pendingChatInput: null,
    pendingChatRunInput: null,
    literatureLibraryScope: null,
  });
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
  mocks.literatureLibraryModel.mockReset().mockResolvedValue({
    items: [],
    collections: [],
    tags: [],
    savedSearches: [],
    specialCollections: [],
  });
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
  mocks.literatureAttachmentOpen.mockReset().mockResolvedValue(undefined);
  mocks.literatureAttachmentOpenExternal.mockReset().mockResolvedValue(undefined);
  mocks.literatureAttachmentStatus.mockReset().mockResolvedValue({ exists: true, bytes: 1024 });
  mocks.literatureAttachmentReadText.mockReset().mockResolvedValue({
    path: "papers/attachments/example.html",
    sourceName: "example.html",
    mimeType: "text/html",
    content: "<p>Example</p>",
  });
  mocks.literatureFullTextSearch.mockReset().mockResolvedValue({
    papers: [],
    exhausted: true,
  });
  mocks.literatureSearchProtocolCreate.mockReset().mockResolvedValue({
    protocol: { id: "protocol-ui" },
  });
  mocks.literatureSearchProtocolPreview.mockReset().mockResolvedValue({
    protocol: { id: "protocol-ui", revision: 1, maxResults: 50 },
    maxResults: 50,
    plan: [{
      source: "crossref",
      query: "grounded review",
      queryVariants: [{
        kind: "broad_keywords",
        query: "grounded review",
        rationale: "broad",
      }],
      maxResults: 50,
      adapterStatus: "available",
      coverageNote: "DOI metadata",
    }],
  });
  mocks.literatureSearchProtocolExecute.mockReset().mockResolvedValue({
    searchRun: {
      id: "run-ui",
      status: "partial",
      recordIds: ["doi:10.1000/example"],
      sourceAttempts: [{
        source: "crossref",
        status: "partial",
        returnedCount: 50,
        coverage: {
          totalHits: 500,
          fetched: 50,
          unique: 50,
          exhausted: false,
          nextCursor: "next-page",
          truncatedReason: "protocol_max_results",
        },
      }],
    },
    warnings: [],
  });
  mocks.literatureSearchCancel.mockReset().mockResolvedValue(true);
  mocks.listenLiteratureSearchProgress.mockReset().mockResolvedValue(() => {});
  mocks.literatureDuplicateCandidates.mockReset().mockResolvedValue([]);
  mocks.literatureMergeDuplicates.mockReset().mockResolvedValue({ primaryRecordId: "arxiv:1111.00001" });
  mocks.literatureImportPdfAsRecord.mockReset().mockResolvedValue({ record: { recordId: "arxiv:1111.00001" } });
  mocks.literatureRestoreItems.mockReset().mockResolvedValue({
    projection: fixtureLibrary(),
  });
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
  mocks.literatureUpdateRelations.mockReset().mockImplementation((recordId, relations) => {
    const current = fixtureLibrary();
    return Promise.resolve({
      recordId,
      relations,
      projection: {
        ...current,
        papers: current.papers.map((paper) =>
          paper.id === recordId ? { ...paper, ...relations } : paper,
        ),
      },
    });
  });
  mocks.literatureUpdateCollections.mockReset().mockImplementation((collections) => {
    const current = fixtureLibrary();
    return Promise.resolve({
      collections,
      projection: { ...current, collections },
    });
  });
  mocks.literatureUpdateItem.mockReset().mockResolvedValue({
    item: undefined,
    projection: fixtureLibrary(),
  });
  mocks.literatureCreateItem.mockReset().mockResolvedValue({
    recordId: "manual:new-item",
    projection: fixtureLibrary(),
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
  // Default: no executor configured, so screening/brief fall back to the
  // offline heuristic. Individual tests opt into the LLM path.
  mocks.literatureLlm.mockReset().mockRejectedValue(new Error("no executor configured"));
  mocks.literatureReviewLlm.mockReset().mockRejectedValue(new Error("no reviewer configured"));
  mocks.literatureLlmVision.mockReset().mockRejectedValue(new Error("no vision executor configured"));
  mocks.literaturePdfOpen.mockReset().mockResolvedValue(undefined);
  mocks.literaturePdfText.mockReset().mockRejectedValue(new Error("no pdf text"));
  mocks.literaturePdfImages.mockReset().mockRejectedValue(new Error("no pdf page images"));
  mocks.literaturePdfBytes.mockReset().mockRejectedValue(new Error("no pdf bytes"));
  mocks.literatureRagIndexPdf.mockReset().mockResolvedValue({
    paperId: fixturePaper.id,
    pageCount: 2,
    ocrUsed: false,
    indexedForSearch: true,
    stats: { indexedChunks: 3, skippedAsCurrent: false, documentContentHash: "hash" },
  });
  mocks.literatureRagIndexLibrary.mockReset().mockResolvedValue({
    forceRebuild: false,
    total: 1,
    indexed: 1,
    skipped: 0,
    failed: 0,
    results: [],
    failures: [],
  });
  mocks.literatureRagStatus.mockReset().mockResolvedValue({
    exists: true,
    indexPath: "C:/project/papers/rag/literature-retrieval.sqlite",
    relativeIndexPath: "papers/rag/literature-retrieval.sqlite",
    databaseBytes: 8192,
    documentCount: 1,
    chunkCount: 3,
    currentCardCount: 2,
    staleCardCount: 0,
    pendingCardCount: 0,
    assetCount: 1,
    citationMentionCount: 4,
    metadataDocumentCount: 1,
    cardPreviews: [{
      chunkId: "chunk-1",
      paperId: fixturePaper.id,
      relativePath: "papers/persisted-paper.pdf",
      pageStart: 2,
      pageEnd: 2,
      updatedAt: "123",
      sourcePreview: "The evaluation protocol is summarized on this page.",
      card: {
        chunkId: "chunk-1",
        sourceContentHash: "hash",
        questions: ["What are the evaluation limitations?"],
        concepts: ["small sample"],
        sectionHeadings: ["Limitations"],
        aliases: ["limited cohort"],
        methods: [],
        datasets: [],
        metrics: [],
        limitations: ["sample size"],
        languageTerms: ["小样本"],
        generatedBy: "test-model",
        promptVersion: 1,
      },
    }],
  });
  mocks.literatureRagCards.mockReset().mockResolvedValue({
    total: 1,
    offset: 0,
    limit: 20,
    query: "",
    cards: [{
      chunkId: "chunk-1",
      paperId: fixturePaper.id,
      relativePath: "papers/persisted-paper.pdf",
      pageStart: 2,
      pageEnd: 2,
      updatedAt: "123",
      sourcePreview: "The evaluation protocol is summarized on this page.",
      card: {
        chunkId: "chunk-1",
        sourceContentHash: "hash",
        questions: ["What are the evaluation limitations?"],
        concepts: ["small sample"],
        sectionHeadings: ["Limitations"],
        aliases: ["limited cohort"],
        methods: [],
        datasets: [],
        metrics: [],
        limitations: ["sample size"],
        languageTerms: ["小样本"],
        generatedBy: "test-model",
        promptVersion: 1,
      },
    }],
  });
  mocks.literatureRagSearch.mockReset().mockResolvedValue({ query: "", results: [] });
  mocks.knowledgeRetrievalCardsBuild.mockReset().mockResolvedValue({
    attempted: 2,
    generated: 2,
    hasMore: false,
    warnings: [],
    stats: { written: 2, unchanged: 0, indexPath: "papers/rag/literature-retrieval.sqlite" },
  });
  mocks.projectRagSearch.mockReset().mockResolvedValue({
    query: "",
    queryPlan: { originalQuery: "", exactTerms: [], aliases: [], subqueries: [], entities: [] },
    knowledge: { query: "", retrieval: "SQLite FTS", results: [], note: "" },
    literature: { query: "", queryPlan: { originalQuery: "", exactTerms: [], aliases: [], subqueries: [], entities: [] }, retrieval: "SQLite FTS", results: [] },
    rerank: [],
  });
  mocks.projectRagAnswer.mockReset().mockResolvedValue({
    query: "",
    answer: "",
    queryPlan: { originalQuery: "", exactTerms: [], aliases: [], subqueries: [], entities: [] },
    knowledge: { query: "", retrieval: "SQLite FTS", results: [], note: "" },
    literature: { query: "", queryPlan: { originalQuery: "", exactTerms: [], aliases: [], subqueries: [], entities: [] }, retrieval: "SQLite FTS", results: [] },
    rerank: [],
    review: { verdict: "pass", findings: [], gapQueries: [] },
  });
  mocks.chatRunCommand.mockReset().mockResolvedValue({
    handled: true,
    message: null,
    prompt: "Expanded /research-lit prompt",
    selection: null,
    replaceTurns: false,
    openSettings: false,
    refreshStatus: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function generateBriefForTest(paperId: string) {
  await act(async () => {
    await useLiteratureStore.getState().generateBrief(paperId);
  });
}

describe("Literature library", () => {
  it("opens a workflow-owned corpus as a bounded library view", async () => {
    const user = userEvent.setup();
    const outsidePaper: LiteraturePaper = {
      ...structuredClone(fixturePaper),
      id: "arxiv:2222.00002",
      title: "Paper Outside the Workflow Corpus",
      arxivId: "2222.00002",
    };
    mocks.literatureLoad.mockResolvedValue({
      ...fixtureLibrary(),
      papers: [structuredClone(fixturePaper), outsidePaper],
    });
    const projectId = useStore.getState().currentProject?.id ?? "default";
    useStore.setState({
      literatureLibraryScope: {
        projectId,
        title: "综述：test · 原始文献库",
        recordIds: [fixturePaper.id],
        workflowRunId: "review-test-1",
      },
    });

    render(<Literature />);

    expect(await screen.findByText("工作流原始文献库")).toBeTruthy();
    expect(screen.getByText(/已显示 1\/1 篇收纳记录/)).toBeTruthy();
    expect(screen.queryByText(outsidePaper.title)).toBeNull();
    // The scope banner renders before the async library load completes. Wait
    // for the bounded corpus before exercising the exit action.
    await screen.findAllByText(fixturePaper.title);

    await user.click(screen.getByRole("button", { name: "退出筛选" }));
    expect(await screen.findByText(outsidePaper.title)).toBeTruthy();
    expect(useStore.getState().literatureLibraryScope).toBeNull();
  });

  it("shows persisted workflow A/B/C/D classifications as library filters", async () => {
    const user = userEvent.setup();
    const workflowRunId = "review-grade-test";
    const gradedA: LiteraturePaper = {
      ...structuredClone(fixturePaper),
      title: "Core Grade A Paper",
      workflowGrades: [{
        workflowRunId,
        workflowTitle: "综述：分级测试",
        grade: "A",
        originalIndex: 1,
        keyFinding: "core",
        rationale: "directly relevant",
        method: "independent_reviewer",
        gradedAt: "2026-08-03T23:05:00Z",
      }],
    };
    const gradedD: LiteraturePaper = {
      ...structuredClone(fixturePaper),
      id: "arxiv:2222.00002",
      title: "Unrelated Grade D Paper",
      arxivId: "2222.00002",
      workflowGrades: [{
        workflowRunId,
        workflowTitle: "综述：分级测试",
        grade: "D",
        originalIndex: 2,
        keyFinding: "none",
        rationale: "unrelated",
        method: "independent_reviewer",
        gradedAt: "2026-08-03T23:05:00Z",
      }],
    };
    mocks.literatureLoad.mockResolvedValue({
      ...fixtureLibrary(),
      papers: [gradedA, gradedD],
    });

    const { container } = render(<Literature />);

    expect(await screen.findByText("A/B/C/D 分级")).toBeTruthy();
    expect(screen.getByText("综述：分级测试")).toBeTruthy();
    expect(screen.getByRole("button", { name: /A · 核心相关/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /D · 无关/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /D · 无关/ }));

    expect((await screen.findAllByText(gradedD.title)).length).toBeGreaterThan(0);
    expect(screen.queryByText(gradedA.title)).toBeNull();
    expect(screen.getByRole("region", { name: "综述：分级测试 · D 级文献" })).toBeTruthy();
    expect(container.querySelector(".lit-row-workflow-grade.grade-d")?.textContent).toBe("D");
  });

  it("places local literature search inside Search and exposes the database inventory", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    expect(screen.queryByLabelText("本地文献检索")).toBeNull();
    expect(screen.queryByRole("button", { name: "全文 RAG" })).toBeNull();
    expect(screen.getByRole("button", { name: "文献视图切换" }).getAttribute("aria-haspopup")).toBe("menu");
    expect(screen.queryByRole("tab", { name: "知识图谱" })).toBeNull();
    await openDiscover(user);

    const ragWorkspace = await screen.findByLabelText("本地文献检索");
    expect(ragWorkspace).toBeTruthy();
    // Discover opens on local search; the external protocol is one click away.
    expect(document.querySelector(".lit-protocol-search")).toBeNull();
    expect(within(ragWorkspace).getByText("基于本地证据提问")).toBeTruthy();
    // The pipeline explainer is collapsed behind a disclosure, not removed.
    expect(within(ragWorkspace).getByLabelText("无向量检索链路")).toBeTruthy();
    expect(within(ragWorkspace).getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByLabelText("外部文献检索")).toBeNull();
    expect(screen.queryByText("发现并导入新文献")).toBeNull();
    expect(screen.getByText(/搜索并保存新文献请直接在 Chat 中提出/)).toBeTruthy();
    const inventory = screen.getByLabelText("本地检索库状态");
    expect(within(inventory).getByText("索引就绪")).toBeTruthy();
    expect(within(inventory).getByText("个页块")).toBeTruthy();
    expect(within(inventory).getByText("检索卡")).toBeTruthy();

    // Maintenance opens on demand so the resting page stays a strip, not a card.
    expect(screen.queryByLabelText("索引维护")).toBeNull();
    await user.click(within(inventory).getByRole("button", { name: /维护/ }));
    const maintenance = screen.getByLabelText("索引维护");
    expect(within(maintenance).getByText("检索卡覆盖")).toBeTruthy();
    expect(within(maintenance).getByText(/元数据 1 篇 · 引用关系 4 条/)).toBeTruthy();

    await user.click(within(inventory).getByText(/浏览全部检索卡/));
    const cardBrowser = await screen.findByRole("dialog", { name: "检索卡浏览器" });
    expect(within(cardBrowser).getByText("What are the evaluation limitations?")).toBeTruthy();
    expect(within(cardBrowser).getByText("small sample")).toBeTruthy();
    expect(within(cardBrowser).getByText(/evaluation protocol is summarized/)).toBeTruthy();
    expect(mocks.literatureRagStatus).toHaveBeenCalledWith(12);
    expect(mocks.literatureRagCards).toHaveBeenCalled();
  });

  it("previews, explicitly confirms, and reports coverage for protocol search", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await openDiscover(user);
    await user.click(screen.getByRole("tab", { name: /外部发现/ }));

    const panel = document.querySelector<HTMLElement>(".lit-protocol-search");
    expect(panel).toBeTruthy();
    const query = panel!.querySelector<HTMLTextAreaElement>("textarea");
    expect(query).toBeTruthy();
    await user.type(query!, "grounded literature review");
    const timeWindow = panel!.querySelector<HTMLInputElement>("input[type='text']");
    expect(timeWindow).toBeTruthy();
    await user.type(timeWindow!, "2020-2025");
    const previewButton = panel!.querySelector<HTMLButtonElement>(
      ".lit-protocol-search-form button.primary",
    );
    await user.click(previewButton!);

    await waitFor(() => {
      expect(mocks.literatureSearchProtocolCreate).toHaveBeenCalled();
      expect(mocks.literatureSearchProtocolPreview).toHaveBeenCalledWith("protocol-ui");
    });
    expect(mocks.literatureSearchProtocolCreate).toHaveBeenCalledWith(
      expect.objectContaining({ timeWindow: "2020-2025", maxResults: 50 }),
    );
    expect(within(panel!).getAllByText("crossref").length).toBeGreaterThan(0);
    expect(within(panel!).getByText("grounded review")).toBeTruthy();

    const confirmation = panel!.querySelector<HTMLInputElement>(
      ".lit-protocol-confirm input[type='checkbox']",
    );
    const executeButton = panel!.querySelector<HTMLButtonElement>(
      ".lit-protocol-confirm button.primary",
    );
    expect(executeButton?.disabled).toBe(true);
    await user.click(confirmation!);
    await user.click(executeButton!);

    await waitFor(() => {
      expect(mocks.literatureSearchProtocolExecute).toHaveBeenCalledWith(
        "protocol-ui",
        "execute",
        undefined,
        undefined,
        // Minted per run so the Stop button has something to address.
        expect.stringMatching(/^literature-search-/),
      );
    });
    expect(within(panel!).getByText(/protocol_max_results/)).toBeTruthy();
    expect(within(panel!).getByText("500")).toBeTruthy();
    expect(within(panel!).getByText("10%")).toBeTruthy();

    const continueButton = panel!.querySelector<HTMLButtonElement>(
      ".lit-protocol-coverage > button.primary",
    );
    expect(continueButton).toBeTruthy();
    await user.click(continueButton!);
    await waitFor(() => {
      expect(mocks.literatureSearchProtocolExecute).toHaveBeenLastCalledWith(
        "protocol-ui",
        "execute",
        "run-ui",
        undefined,
        expect.stringMatching(/^literature-search-/),
      );
    });
  });

  it("lets the user stop a running search and continue it afterwards", async () => {
    const user = userEvent.setup();
    // Hold the run open so the Stop button is on screen while it is in flight.
    let finishRun: (result: unknown) => void = () => {};
    mocks.literatureSearchProtocolExecute.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishRun = resolve;
      }),
    );
    mocks.literatureSearchCancel.mockResolvedValue(true);

    render(<Literature />);
    await openDiscover(user);
    await user.click(screen.getByRole("tab", { name: /外部发现/ }));
    const panel = document.querySelector<HTMLElement>(".lit-protocol-search");
    await user.type(
      panel!.querySelector<HTMLTextAreaElement>("textarea")!,
      "grounded literature review",
    );
    await user.click(panel!.querySelector<HTMLButtonElement>(
      ".lit-protocol-search-form button.primary",
    )!);
    await waitFor(() => {
      expect(mocks.literatureSearchProtocolPreview).toHaveBeenCalledWith("protocol-ui");
    });

    await user.click(panel!.querySelector<HTMLInputElement>(
      ".lit-protocol-confirm input[type='checkbox']",
    )!);
    await user.click(panel!.querySelector<HTMLButtonElement>(
      ".lit-protocol-confirm button.primary",
    )!);

    const stopButton = await waitFor(() => {
      const button = within(panel!).getByRole("button", { name: /Stop|停止检索/ });
      expect(button).toBeTruthy();
      return button;
    });
    await user.click(stopButton);

    await waitFor(() => {
      expect(mocks.literatureSearchCancel).toHaveBeenCalledWith(
        expect.stringMatching(/^literature-search-/),
      );
    });
    // The same id the run was started with, or the kernel would never see it.
    expect(mocks.literatureSearchCancel.mock.calls[0][0]).toBe(
      mocks.literatureSearchProtocolExecute.mock.calls[0][4],
    );

    finishRun({
      searchRun: {
        id: "run-stopped",
        status: "partial",
        recordIds: ["doi:kept"],
        sourceAttempts: [],
      },
      warnings: [],
      cancelled: true,
    });

    // A stop leaves sources that were never attempted and so produce no
    // attempt row; the run must still offer to continue.
    const continueButton = await waitFor(() => {
      const button = panel!.querySelector<HTMLButtonElement>(
        ".lit-protocol-coverage > button.primary",
      );
      expect(button).toBeTruthy();
      return button!;
    });
    await user.click(continueButton);
    await waitFor(() => {
      expect(mocks.literatureSearchProtocolExecute).toHaveBeenLastCalledWith(
        "protocol-ui",
        "execute",
        "run-stopped",
        undefined,
        expect.stringMatching(/^literature-search-/),
      );
    });
  });

  it("builds a page-aware local FTS index without requiring an embedding configuration", async () => {
    const library = fixtureLibrary();
    library.papers[0].pdf = { status: "downloaded", path: "papers/persisted-paper.pdf" };
    mocks.literatureLoad.mockResolvedValue(library);
    const pages = [
      { page: 1, text: "First page text", source: "embedded" },
      { page: 2, text: "Second page text", source: "ocr" },
    ];
    mocks.literaturePdfText.mockResolvedValue({
      text: "[[PAGE 1]]\nFirst page text\n\n[[PAGE 2]]\nSecond page text",
      pages,
      totalCharacters: 32,
      extractedCharacters: 32,
      truncated: false,
      ocrUsed: true,
      missingPages: [],
      warnings: [],
    });
    const user = userEvent.setup();
    render(<Literature />);

    await openDiscover(user);
    await user.click(await screen.findByRole("button", { name: /维护/ }));
    await user.click(screen.getByRole("button", { name: "索引当前 PDF" }));

    await waitFor(() => expect(mocks.literatureRagIndexPdf).toHaveBeenCalledWith(
      "papers/persisted-paper.pdf",
      fixturePaper.id,
    ));
    expect(mocks.knowledgeRetrievalCardsBuild).toHaveBeenCalledWith(fixturePaper.id, 24);
    expect(await within(screen.getByLabelText("本地文献检索")).findByText(/已建立 3 个本地可引用页块/)).toBeTruthy();
  });

  it("builds retrieval cards in background batches and exposes no embedding controls", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    await openDiscover(user);
    await user.click(await screen.findByRole("button", { name: /维护/ }));
    expect(screen.queryByText("语义增强（可选）")).toBeNull();
    expect(screen.queryByLabelText("嵌入模型")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "自动生成检索卡" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "补建检索卡" }));
    await waitFor(() => expect(mocks.knowledgeRetrievalCardsBuild).toHaveBeenCalledWith(undefined, 24));
    expect((await screen.findAllByText(/已处理 2 个页块，生成 2 张卡/)).length).toBeGreaterThan(0);
  });

  it("automatically continues retrieval-card batches after indexing the library", async () => {
    mocks.knowledgeRetrievalCardsBuild
      .mockResolvedValueOnce({
        attempted: 24,
        generated: 24,
        hasMore: true,
        warnings: [],
        stats: { written: 24, unchanged: 0, indexPath: "papers/rag/literature-retrieval.sqlite" },
      })
      .mockResolvedValueOnce({
        attempted: 5,
        generated: 5,
        hasMore: false,
        warnings: [],
        stats: { written: 5, unchanged: 0, indexPath: "papers/rag/literature-retrieval.sqlite" },
      });
    const user = userEvent.setup();
    render(<Literature />);

    await openDiscover(user);
    await user.click(await screen.findByRole("button", { name: /维护/ }));
    await user.click(screen.getByRole("button", { name: "增量更新全库" }));

    await waitFor(() => expect(mocks.knowledgeRetrievalCardsBuild).toHaveBeenCalledTimes(2));
    expect(mocks.knowledgeRetrievalCardsBuild).toHaveBeenNthCalledWith(1, undefined, 24);
    expect(mocks.knowledgeRetrievalCardsBuild).toHaveBeenNthCalledWith(2, undefined, 24);
    expect((await screen.findAllByText(/检索卡后台构建完成：已处理 29 个页块，生成 29 张卡/)).length).toBeGreaterThan(0);
  });

  it("does not auto-build cards after indexing when the switch is off", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    await openDiscover(user);
    await user.click(await screen.findByRole("button", { name: /维护/ }));
    await user.click(screen.getByRole("checkbox", { name: "自动生成检索卡" }));
    expect((screen.getByRole("checkbox", { name: "自动生成检索卡" }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "增量更新全库" }));

    await waitFor(() => expect(mocks.literatureRagIndexLibrary).toHaveBeenCalledWith(false));
    expect(mocks.knowledgeRetrievalCardsBuild).not.toHaveBeenCalled();
    expect((await screen.findAllByText(/自动检索卡生成已关闭/)).length).toBeGreaterThan(0);
  });

  it("shows confirmed knowledge separately from PDF page chunks in unified RAG search", async () => {
    mocks.projectRagSearch.mockResolvedValue({
      query: "limitations",
      queryPlan: { originalQuery: "limitations", exactTerms: ["limitations"], aliases: ["constraints"], subqueries: [], entities: [] },
      knowledge: {
        query: "limitations",
        retrieval: "SQLite FTS",
        note: "Confirmed only",
        results: [{
          rank: 1,
          retrievalScore: 0.03,
          matchedQueries: ["limitations"],
          knowledge: {
            id: "kp-1",
            question: "What is the limitation?",
            answer: "The sample is small.",
            statement: "The evaluation uses a small sample.",
            snippet: "small sample",
            evidence: [{ paperId: fixturePaper.id, page: 2, quote: "Only 20 samples were used." }],
          },
        }],
      },
      literature: {
        query: "limitations",
        queryPlan: { originalQuery: "limitations", exactTerms: ["limitations"], aliases: ["constraints"], subqueries: [], entities: [] },
        retrieval: "SQLite FTS (PDF page chunks)",
        results: [{
          chunk: {
            chunkId: "pdf-1",
            paperId: fixturePaper.id,
            relativePath: "papers/persisted-paper.pdf",
            pageStart: 2,
            pageEnd: 2,
            pageSource: "ocr",
            ordinalOnPage: 0,
            text: "Only 20 samples were used in the evaluation.",
            contentHash: "chunk-hash",
            chunkerVersion: "pdf-page-v1",
          },
          rank: 1,
          retrievalScore: 0.016,
          sourceRank: 1,
          matchedQueries: ["limitations", "constraints"],
        }],
      },
      rerank: [{ id: "P:pdf-1", relevance: 3, reason: "direct limitation evidence" }],
    });
    const user = userEvent.setup();
    render(<Literature />);

    await openDiscover(user);
    await user.type(screen.getByRole("textbox", { name: "检索问题" }), "limitations");
    await user.click(screen.getByRole("button", { name: "仅检索证据" }));

    expect(await screen.findByText("The evaluation uses a small sample.")).toBeTruthy();
    expect(screen.getByText("Only 20 samples were used in the evaluation.")).toBeTruthy();
    expect(screen.getByText("已确认知识")).toBeTruthy();
    expect(screen.getByText("PDF 原文页块")).toBeTruthy();
    expect(screen.getByText("原文匹配 #1")).toBeTruthy();
    expect(screen.getByText(/扩展词：limitations \/ constraints/)).toBeTruthy();
    expect(mocks.projectRagSearch).toHaveBeenCalledWith("limitations", 8);
  });

  it("uses the configured SomniQ LLM to answer from local FTS evidence without embeddings", async () => {
    mocks.projectRagAnswer.mockResolvedValue({
      query: "limitations",
      answer: "The evaluation is limited by a small sample [P1 arxiv:1111.00001 p.2 raw-pdf-ocr].",
      queryPlan: { originalQuery: "limitations", exactTerms: [], aliases: [], subqueries: [], entities: [] },
      knowledge: { query: "limitations", retrieval: "SQLite FTS", note: "", results: [] },
      literature: { query: "limitations", queryPlan: { originalQuery: "limitations", exactTerms: [], aliases: [], subqueries: [], entities: [] }, retrieval: "SQLite FTS", results: [] },
      rerank: [],
      review: { verdict: "pass", findings: ["All claims are page-grounded."], gapQueries: [] },
    });
    const user = userEvent.setup();
    render(<Literature />);

    await openDiscover(user);
    await user.type(screen.getByRole("textbox", { name: "检索问题" }), "limitations");
    await user.click(screen.getByRole("button", { name: "检索并回答" }));

    expect(await screen.findByText(/The evaluation is limited by a small sample/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Persisted Paper on Grounded Reading · p.2" }),
    ).toBeTruthy();
    expect(screen.queryByText(/P1 arxiv:1111\.00001/)).toBeNull();
    expect(screen.getByText(/独立审校：All claims are page-grounded/)).toBeTruthy();
    expect(mocks.projectRagAnswer).toHaveBeenCalledWith("limitations", 8);
  });

  it("keeps the reference manager as the default view and exposes the canonical SQLite store", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    expect(await screen.findAllByText("Persisted Paper on Grounded Reading")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
    expect(await screen.findByTitle(/本地 SQLite · 模式 v1 · 健康 · 1 条规范记录 · 4 KB · 尚未备份/)).toBeTruthy();

    const detailNavigation = screen.getByRole("tablist", { name: "论文详情导航" });
    const infoTab = within(detailNavigation).getByRole("tab", { name: "信息" });
    expect(infoTab.textContent).toBe("信息");
    for (const name of ["简报", "证据", "笔记"]) {
      expect(within(detailNavigation).queryByRole("tab", { name })).toBeNull();
    }
    expect(within(detailNavigation).getByRole("tab", { name: "论文讲解" }).querySelector("svg")?.getAttribute("data-icon")).toBe("paperGuide");
    expect(infoTab.getAttribute("aria-selected")).toBe("true");
    const relatedTab = within(detailNavigation).getByRole("tab", { name: "相关" });
    await user.click(relatedTab);
    expect(relatedTab.getAttribute("aria-selected")).toBe("true");

    await user.click(screen.getByRole("button", { name: "备份数据库" }));
    await waitFor(() => expect(mocks.literatureStorageBackup).toHaveBeenCalledTimes(1));

    await openDiscover(user);
    expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "检索问题" })).toBeTruthy();
  });

  it("opens metadata editing from the Info section and saves the Citation key", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    const infoSection = document.querySelector<HTMLElement>(".lip-editable-info");
    expect(infoSection).toBeTruthy();
    fireEvent.doubleClick(infoSection as HTMLElement);
    const citationKey = screen.getByRole("textbox", { name: "Citation key" });
    await user.type(citationKey, "first2026");
    await user.click(screen.getByRole("button", { name: "保存元数据" }));
    await waitFor(() => expect(useLiteratureStore.getState().library.papers[0].citationKey).toBe("first2026"));

    expect(screen.getByRole("button", { name: "编辑元数据" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "编辑 Citation key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "简报" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看证据" })).toBeNull();
  });

  it("keeps the database integrity check out of the footer status poll", async () => {
    // The integrity check reads every page of the database — seconds on a
    // large library — while the footer status is re-read whenever the paper or
    // saved-search count changes. Asking for both together is what froze the
    // window on every library load.
    const health = {
      healthy: true,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      journalMode: "wal",
    };
    const status = {
      schemaVersion: 1,
      databasePath: "C:/project/.somniq/literature/literature.sqlite3",
      databaseBytes: 4096,
      canonicalRecordCount: 1,
      searchRunCount: 0,
      latestBackup: null,
      projectionPath: "C:/project/papers/library.json",
      projectionExists: true,
    };
    mocks.literatureStorageStatus
      .mockReset()
      .mockImplementation(async (includeHealth?: boolean) =>
        includeHealth ? { ...status, health } : status,
      );

    render(<Literature />);

    expect(await screen.findByTitle(/本地 SQLite · 模式 v1 · 健康 · 1 条规范记录/)).toBeTruthy();
    const withHealth = mocks.literatureStorageStatus.mock.calls.filter(
      (call: unknown[]) => call[0] === true,
    );
    expect(withHealth).toHaveLength(1);
    expect(mocks.literatureStorageStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("loads the persisted library and shows pipeline counts", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    expect(await screen.findAllByText("Persisted Paper on Grounded Reading")).toBeTruthy();
    expect(mocks.literatureLoad).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "状态" }));
    expect(screen.getByRole("button", { name: "收件箱 1" })).toBeTruthy();
    expect(screen.getByText("1 paper · 0 PDFs")).toBeTruthy();
  });

  it("keeps every import route available in a populated library and creates a manual item", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "添加文献" }));
    const addMenu = screen.getByRole("menu", { name: "添加文献" });
    expect(within(addMenu).getAllByRole("menuitem")).toHaveLength(4);
    expect(within(addMenu).getByRole("menuitem", { name: /导入 PDF/ })).toBeTruthy();
    expect(within(addMenu).getByRole("menuitem", { name: /导入文献库/ })).toBeTruthy();
    expect(within(addMenu).getByRole("menuitem", { name: /添加 DOI/ })).toBeTruthy();
    await user.click(within(addMenu).getByRole("menuitem", { name: /新建条目/ }));
    const dialog = screen.getByRole("dialog", { name: "新建文献条目" });
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "Manual local reference");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "条目类型" }), "book");
    await user.type(within(dialog).getByRole("textbox", { name: "作者" }), "Ada Lovelace");
    await user.click(within(dialog).getByRole("button", { name: "创建条目" }));

    await waitFor(() => expect(mocks.literatureCreateItem).toHaveBeenCalledWith({
      itemType: "book",
      title: "Manual local reference",
      creators: [{ name: "Ada Lovelace" }],
      tags: [],
    }));
  });

  it("clears the paper filter immediately from the list toolbar", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    const filter = screen.getByRole("textbox", { name: "筛选论文" });
    await user.type(filter, "grounded");
    expect(screen.getByRole("button", { name: "清除文献筛选" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除文献筛选" }));
    expect((filter as HTMLInputElement).value).toBe("");
  });


  it("matches mixed-case title and author queries and clears with Escape", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers.push({ ...structuredClone(fixturePaper), id: "second", title: "Unrelated reference", authors: ["C. Three"] });
    mocks.literatureLoad.mockResolvedValue(library);
    mocks.literatureFullTextSearch.mockResolvedValue({
      paperIds: [fixturePaper.id],
      total: 1,
      exhausted: true,
    });
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    const filter = screen.getByRole("textbox", { name: "筛选论文" });
    for (const query of ["Grounded Reading", "A. ONE"]) {
      fireEvent.change(filter, { target: { value: query } });
      await waitFor(() => expect(mocks.literatureFullTextSearch).toHaveBeenCalledWith(query, 100, 0));
      await screen.findByRole("checkbox", { name: "选择 " + fixturePaper.title });
      const list = screen.getByRole("grid", { name: "文献列表" });
      expect(within(list).getByText(fixturePaper.title)).toBeTruthy();
      expect(within(list).queryByText("Unrelated reference")).toBeNull();
    }
    await user.click(filter);
    await user.keyboard("{Escape}");
    expect((filter as HTMLInputElement).value).toBe("");
    expect(await screen.findByRole("checkbox", { name: "选择 Unrelated reference" })).toBeTruthy();
  });

  it("selects the visible corpus and exposes recently added and recently read views", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("checkbox", { name: "选择当前列表中的全部条目" }));
    expect((screen.getByRole("checkbox", { name: "选择 Persisted Paper on Grounded Reading" }) as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getAllByText("Persisted Paper on Grounded Reading")[0]);
    expect(useLiteratureStore.getState().library.papers[0].unread).toBe(true);
    await user.click(screen.getByRole("button", { name: "标记为已读" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "最近阅读 1" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "最近添加 1" }));
    expect(screen.getAllByText("最近添加").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "最近阅读 1" }));
    expect(screen.getAllByText("最近阅读").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Persisted Paper on Grounded Reading").length).toBeGreaterThan(0);
  });

  it("toggles the selected paper between read and unread without selecting the row", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    const readToggle = screen.getByRole("button", { name: "标记为已读" });
    await user.click(readToggle);
    expect(screen.getByRole("button", { name: "标记为未读" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "标记为未读" }));
    expect(screen.getByRole("button", { name: "标记为已读" })).toBeTruthy();
  });

  it("shows the five-star rating control and edits Related links", async () => {
    const user = userEvent.setup();
    mocks.literatureLibraryModel.mockResolvedValue({
      ...fixtureLibraryModel(),
      tags: [{ id: "tag-reading", name: "reading", kind: "user", tagType: 0, color: "#ef4444" }],
    });
    mocks.literatureUpdateItem.mockResolvedValue({
      item: undefined,
      projection: {
        ...fixtureLibrary(),
        papers: [{ ...structuredClone(fixturePaper), rating: 4 }],
      },
    });
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "设置评分 4 星" }));
    await waitFor(() => expect(mocks.literatureUpdateItem).toHaveBeenCalledWith(
      "arxiv:1111.00001",
      expect.objectContaining({
        fields: expect.objectContaining({ rating: "4" }),
      }),
    ));
    await user.click(screen.getByRole("button", { name: "清除评分" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "设置标签“reading”颜色" }),
      "#ef4444",
    );
    await waitFor(() => expect(mocks.literatureUpdateRelations).toHaveBeenCalledWith(
      "arxiv:1111.00001",
      expect.objectContaining({
        tags: expect.arrayContaining([
          expect.objectContaining({ tag: "reading", color: "#ef4444" }),
        ]),
      }),
    ));

    await user.click(screen.getByRole("tab", { name: "相关" }));
    const target = screen.getByPlaceholderText("输入条目 ID、标题或 URI…");
    await user.type(target, "https://example.test/related");
    await user.click(screen.getByRole("button", { name: "添加关联" }));
    expect(screen.getByText("https://example.test/related")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "移除" }));
    expect(screen.getByText("暂无 Related 关系。")).toBeTruthy();
  });

  it("can retry an initial library load and clears the stale error after recovery", async () => {
    const user = userEvent.setup();
    mocks.literatureLoad
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce(fixtureLibrary());

    const { container } = render(<Literature />);

    const errorBanner = await waitFor(() => {
      const banner = container.querySelector(".lit-error-banner");
      expect(banner).not.toBeNull();
      return banner as HTMLElement;
    });
    expect(
      within(errorBanner).getByText(/文献库加载失败：Error: database temporarily unavailable/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findAllByText("Persisted Paper on Grounded Reading")).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".lit-error-banner")).toBeNull());
    expect(mocks.literatureLoad).toHaveBeenCalledTimes(2);
  });

  it("keeps the nav short by hiding empty later stages", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    expect(screen.queryByRole("button", { name: "收件箱 1" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "状态" }));
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

    await screen.findAllByText("Persisted Paper on Grounded Reading");
    expect(await screen.findByText("暂无摘要。")).toBeTruthy();
  });

  it("allows the paper workspace selection to be cleared", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(within(screen.getByRole("region", { name: "文献详情" })).getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "清除选择" }));

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

  it("offers collection creation from the empty state, the library root and a collection row", async () => {
    const user = userEvent.setup();
    // An empty tree used to expose creation only through a dim icon in the
    // section header, which people looking for Zotero's "New Collection" did
    // not find at all.
    mocks.literatureLoad.mockResolvedValue(fixtureLibrary());
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "新建第一个分类" }));
    const nameField = await screen.findByPlaceholderText("分类名称…");
    await user.type(nameField, "读书笔记{Enter}");
    await waitFor(() =>
      expect(
        useLiteratureStore.getState().library.collections.map((entry) => entry.label),
      ).toEqual(["读书笔记"]),
    );

    // Right-clicking the library root is the affordance Zotero users reach
    // for first.
    fireEvent.contextMenu(document.querySelector(".lit-library-root") as HTMLElement, { clientX: 40, clientY: 40 });
    const rootMenu = await screen.findByRole("menu");
    await user.click(within(rootMenu).getByRole("menuitem", { name: "新建一级分类" }));
    expect(screen.getByPlaceholderText("分类名称…")).toBeTruthy();
    await user.keyboard("{Escape}");

    // And the same menu on a collection row covers subcollection, rename and
    // delete without a `window.prompt`, which the desktop webview drops.
    const sidebarPanel = document.querySelector<HTMLElement>(".lit-sidebar");
    expect(sidebarPanel).toBeTruthy();
    fireEvent.contextMenu(within(sidebarPanel!).getByText("读书笔记"), { clientX: 40, clientY: 80 });
    const rowMenu = await screen.findByRole("menu");
    expect(within(rowMenu).getByRole("menuitem", { name: "新建子分类" })).toBeTruthy();
    expect(within(rowMenu).getByRole("menuitem", { name: "删除分类…" })).toBeTruthy();
    await user.click(within(rowMenu).getByRole("menuitem", { name: "重命名分类…" }));
    const renameField = await screen.findByRole("textbox", { name: "重命名 读书笔记" });
    await user.clear(renameField);
    await user.type(renameField, "文献笔记{Enter}");
    await waitFor(() =>
      expect(
        useLiteratureStore.getState().library.collections.map((entry) => entry.label),
      ).toEqual(["文献笔记"]),
    );
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

    await user.click(screen.getByRole("button", { name: "获取所选论文 PDF" }));

    expect(mocks.literatureDownloadPdf).toHaveBeenCalledWith(
      "https://arxiv.org/pdf/1111.00001.pdf",
      "1111.00001.pdf",
    );
    expect(screen.getByText("1 paper · 1 PDF")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "状态" }));
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

  it("mounts only the first visible window for a large literature table", async () => {
    const library = fixtureLibrary();
    library.papers = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(fixturePaper),
      id: `arxiv:virtual-${index}`,
      title: `Large library paper ${index}`,
    }));
    mocks.literatureLoad.mockResolvedValue(library);

    render(<Literature />);

    await screen.findAllByText("Large library paper 0");
    const mountedRows = document.querySelectorAll(".lit-row").length;
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(library.papers.length);
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

  it("keeps annotation and note attachment links consistent when a secondary PDF is removed", () => {
    const paper: LiteraturePaper = {
      ...structuredClone(fixturePaper),
      pdf: { status: "downloaded", path: "papers/main.pdf" },
      attachments: [
        {
          id: "pdf-main",
          label: "main.pdf",
          kind: "pdf",
          path: "papers/main.pdf",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "pdf-secondary",
          label: "supplement.pdf",
          kind: "pdf",
          path: "papers/supplement.pdf",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      pdfAnnotations: [{
        id: "secondary-annotation",
        attachmentId: "pdf-secondary",
        page: 7,
        quote: "A secondary PDF excerpt.",
        note: "Keep the source link.",
        kind: "note",
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
    };
    useLiteratureStore.setState({ library: { ...fixtureLibrary(), papers: [paper] }, loaded: true });

    act(() => {
      useLiteratureStore.getState().createNoteFromAnnotation(paper.id, "secondary-annotation");
    });
    expect(useLiteratureStore.getState().library.papers[0].notes?.[0]?.attachmentId).toBe("pdf-secondary");

    act(() => {
      useLiteratureStore.getState().removeAttachment(paper.id, "pdf-secondary");
    });
    const current = useLiteratureStore.getState().library.papers[0];
    expect(current.pdfAnnotations[0].attachmentId).toBeUndefined();
    expect(current.notes?.[0]?.attachmentId).toBeUndefined();
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

  it("keeps the primary PDF pointer in sync when its attachment is relinked", async () => {
    const library = fixtureLibrary();
    library.papers[0] = {
      ...library.papers[0],
      pdf: { status: "downloaded", path: "papers/original.pdf", bytes: 100 },
      attachments: [{
        id: "primary-pdf",
        label: "original.pdf",
        kind: "pdf",
        path: "papers/original.pdf",
        bytes: 100,
        addedAt: "2026-06-01T00:00:00.000Z",
      }],
    };
    mocks.literatureImportAttachment.mockResolvedValueOnce({
      path: "C:/project/papers/relinked.pdf",
      relativePath: "papers/relinked.pdf",
      fileName: "relinked.pdf",
      bytes: 200,
      mimeType: "application/pdf",
    });
    useLiteratureStore.setState({ library, loaded: true });

    await act(async () => {
      await useLiteratureStore.getState().relinkAttachment(
        library.papers[0].id,
        "primary-pdf",
        "C:/researcher/relinked.pdf",
      );
    });

    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.pdf).toEqual(expect.objectContaining({
      status: "downloaded",
      path: "papers/relinked.pdf",
      bytes: 200,
    }));
    expect(paper.attachments?.[0]).toEqual(expect.objectContaining({
      id: "primary-pdf",
      path: "papers/relinked.pdf",
      linkMode: "imported_file",
    }));
    expect(mocks.literatureUpdateRelations).toHaveBeenCalledWith(
      library.papers[0].id,
      expect.objectContaining({ pdf: expect.objectContaining({ path: "papers/relinked.pdf" }) }),
    );
  });

  it("normalizes collection ids before toggling membership", async () => {
    const library = fixtureLibrary();
    library.collections = [{
      id: "collection-a",
      label: "Collection A",
      orderIndex: 0,
    }];
    useLiteratureStore.setState({ library, loaded: true });

    await act(async () => {
      await useLiteratureStore.getState().toggleCollection(library.papers[0].id, " collection-a ");
    });
    expect(useLiteratureStore.getState().library.papers[0].collectionIds).toEqual(["collection-a"]);

    await act(async () => {
      await useLiteratureStore.getState().toggleCollection(library.papers[0].id, " collection-a ");
    });
    expect(useLiteratureStore.getState().library.papers[0].collectionIds).toEqual([]);
  });

  it("opens an already downloaded PDF in the embedded reader", async () => {
    const user = userEvent.setup();
    const downloaded = fixtureLibrary();
    downloaded.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(downloaded);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "打开所选论文 PDF" }));

    // Opening a downloaded PDF takes over the body with the immersive reading
    // shell (full-width reader + a back button), not the cramped side panel.
    expect(screen.getByRole("button", { name: "返回" })).toBeTruthy();
    expect(mocks.literaturePdfOpen).not.toHaveBeenCalled();
    expect(mocks.literatureDownloadPdf).not.toHaveBeenCalled();
  });

  it("opens mutually exclusive guide and record panels while preserving the PDF", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(screen.getByRole("button", { name: "打开所选论文 PDF" }));
    const rail = screen.getByRole("tablist", { name: "论文详情导航" });
    // A cold suite must also load the reader chunk before its toolbar appears.
    const toggle = await screen.findByRole("button", { name: "论文讲解" }, { timeout: 5000 });
    const pdf = document.querySelector(".lit-pdf-reader");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("complementary", { name: "论文讲解" })).toBeNull();
    for (const name of ["简报", "证据", "笔记", "PDF"]) {
      expect(within(rail).queryByRole("tab", { name })).toBeNull();
    }
    for (const tab of within(rail).getAllByRole("tab")) {
      expect(tab.querySelector("svg")).toBeTruthy();
      expect(tab.getAttribute("title")).toBe(tab.getAttribute("aria-label"));
    }
    const guideTab = within(rail).getByRole("tab", { name: "论文讲解" });
    expect(guideTab.querySelector("svg")?.getAttribute("data-icon")).toBe("paperGuide");
    await user.click(guideTab);
    expect(screen.getByRole("complementary", { name: "论文讲解" })).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await user.click(within(rail).getByRole("tab", { name: "信息" }));
    expect(screen.queryByRole("complementary", { name: "论文讲解" })).toBeNull();
    expect(screen.getByRole("tabpanel", { name: "信息" })).toBeTruthy();
    await user.click(toggle);
    expect(screen.queryByRole("tabpanel", { name: "信息" })).toBeNull();
    expect(guideTab.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".lit-pdf-reader")).toBe(pdf);
    await user.click(screen.getByRole("button", { name: "关闭讲解" }));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    await user.click(within(rail).getByRole("tab", { name: "文件" }));
    expect(screen.getByRole("tabpanel", { name: "文件" })).toBeTruthy();
    await user.click(within(rail).getByRole("tab", { name: "文件" }));
    expect(screen.queryByRole("tabpanel", { name: "文件" })).toBeNull();
    await user.click(within(rail).getByRole("tab", { name: "相关" }));
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(within(screen.getByRole("region", { name: "文献详情" })).getByRole("tab", { name: "相关" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens the guide directly and restores focus when guide and detail panels close with Escape", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(screen.getByRole("tab", { name: "论文讲解" }));
    expect(await screen.findByRole("complementary", { name: "论文讲解" })).toBeTruthy();
    screen.getByRole("button", { name: "关闭讲解" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "论文讲解" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "论文讲解" }));
    const rail = screen.getByRole("tablist", { name: "论文详情导航" });
    const info = within(rail).getByRole("tab", { name: "信息" });
    await user.click(info);
    screen.getByRole("button", { name: "收起侧栏，只看 PDF" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tabpanel", { name: "信息" })).toBeNull();
    expect(document.activeElement).toBe(info);
    const guide = within(rail).getByRole("tab", { name: "论文讲解" });
    guide.focus();
    await user.keyboard("{Home}{Home}");
    expect(guide.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Escape}");
    expect(guide.getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector('.lit-reader-detail-rail [tabindex="0"]')).toBe(guide);
  });

  it("opens local PDFs on double-click and switches document tabs", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    const first = library.papers[0];
    const second: LiteraturePaper = {
      ...structuredClone(fixturePaper),
      id: "arxiv:2222.00002",
      title: "Second Stored Paper",
      arxivId: "2222.00002",
      pdf: { status: "downloaded", path: "papers/2222.00002.pdf" },
    };
    first.pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
    library.papers.push(second);
    mocks.literatureLoad.mockResolvedValue(library);

    render(<Literature />);
    await screen.findAllByText(first.title);
    const rowFor = (title: string) => Array.from(document.querySelectorAll<HTMLTableRowElement>(".lit-row"))
      .find((row) => row.textContent?.includes(title));

    const firstRow = rowFor(first.title);
    expect(firstRow).toBeTruthy();
    fireEvent.doubleClick(firstRow as HTMLTableRowElement);
    const documents = await screen.findByRole("tablist", { name: "已打开的 PDF" });
    expect(within(documents).getByRole("tab", { name: first.title }).getAttribute("aria-selected")).toBe("true");

    const readerNavigation = screen.getByRole("tablist", { name: "论文详情导航" });
    expect(within(readerNavigation).getByRole("tab", { name: "论文讲解" }).getAttribute("aria-selected")).toBe("false");
    expect(within(readerNavigation).getByRole("tab", { name: "信息" })).toBeTruthy();
    expect(document.querySelector(".lit-reading-tabs")).toBeNull();
    await user.click(screen.getByRole("button", { name: "返回" }));
    const secondRow = rowFor(second.title);
    expect(secondRow).toBeTruthy();
    fireEvent.doubleClick(secondRow as HTMLTableRowElement);
    const updatedDocuments = await screen.findByRole("tablist", { name: "已打开的 PDF" });
    expect(within(updatedDocuments).getByRole("tab", { name: second.title })).toBeTruthy();

    await user.click(within(updatedDocuments).getByRole("tab", { name: first.title }));
    await waitFor(() =>
      expect(within(updatedDocuments).getByRole("tab", { name: first.title }).getAttribute("aria-selected")).toBe("true"),
    );
    await user.click(screen.getByRole("button", { name: `关闭 ${first.title}` }));
    expect(within(updatedDocuments).queryByRole("tab", { name: first.title })).toBeNull();
    expect(within(updatedDocuments).getByRole("tab", { name: second.title }).getAttribute("aria-selected")).toBe("true");
  });

  it("does not expose review-task workflows in the library UI", async () => {
    const library = fixtureLibrary();
    library.reviewTasks = [{
      id: "task-review",
      question: "Which agents ground claims?",
      criteria: [],
      searchIds: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      suggestions: [],
    }];
    mocks.literatureLoad.mockResolvedValue(library);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    expect(screen.queryByText("审查任务")).toBeNull();
    expect(screen.queryByRole("button", { name: "新建审查任务" })).toBeNull();
    expect(screen.queryByLabelText("文献审查工作流")).toBeNull();
  });

  it("exposes the local Unfiled special collection", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "状态" }));
    await user.click(screen.getByRole("button", { name: "未分类 1" }));

    expect(screen.getAllByText("Persisted Paper on Grounded Reading").length).toBeGreaterThan(0);
  });

  it("renders normalized child attachments only while their parent is expanded", async () => {
    const user = userEvent.setup();
    mocks.literatureLibraryModel.mockResolvedValueOnce(fixtureLibraryModel());

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    expect(screen.queryByText("main.pdf")).toBeNull();
    const parentRow = within(screen.getByRole("grid", { name: "文献列表" })).getByText("Persisted Paper on Grounded Reading").closest("tr")!;
    await waitFor(() => expect(parentRow.getAttribute("aria-expanded")).toBe("false"));
    parentRow.focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("main.pdf")).toBeTruthy();

    parentRow.focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByText("main.pdf")).toBeNull();
  });

  it("opens an image supplement in the in-app viewer instead of the system image app", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers[0] = {
      ...library.papers[0],
      attachments: [{
        id: "figure-1",
        label: "figure-1.png",
        kind: "supplement",
        path: "papers/attachments/figure-1.png",
        addedAt: "2026-06-01T00:00:00.000Z",
      }],
    };
    mocks.literatureLoad.mockResolvedValue(library);
    mocks.literaturePdfBytes.mockResolvedValue([137, 80, 78, 71]);
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:figure-1"),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true, configurable: true });

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    const parentRow = within(screen.getByRole("grid", { name: "文献列表" })).getByText("Persisted Paper on Grounded Reading").closest("tr")!;
    await waitFor(() => expect(parentRow.getAttribute("aria-expanded")).toBe("false"));
    parentRow.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(within(screen.getByRole("grid", { name: "文献列表" })).getByText("figure-1.png").closest("tr") as HTMLElement);

    const viewer = await screen.findByRole("dialog", { name: "figure-1.png" });
    expect(mocks.literaturePdfBytes).toHaveBeenCalledWith("papers/attachments/figure-1.png");
    expect(mocks.literatureAttachmentOpen).not.toHaveBeenCalled();
    expect(within(viewer).getByAltText("figure-1.png").getAttribute("src")).toBe("blob:figure-1");
  });

  it("opens an annotation on its secondary PDF and preserves the page target", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers[0] = {
      ...library.papers[0],
      pdf: { status: "downloaded", path: "papers/main.pdf" },
      attachments: [
        {
          id: "pdf-main",
          label: "main.pdf",
          kind: "pdf",
          path: "papers/main.pdf",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "pdf-secondary",
          label: "supplement.pdf",
          kind: "pdf",
          path: "papers/supplement.pdf",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      pdfAnnotations: [{
        id: "secondary-annotation",
        attachmentId: "pdf-secondary",
        page: 7,
        quote: "A secondary PDF excerpt.",
        note: "Keep the source link.",
        kind: "note",
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
    };
    mocks.literatureLoad.mockResolvedValue(library);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    const parentRow = within(screen.getByRole("grid", { name: "文献列表" })).getByText("Persisted Paper on Grounded Reading").closest("tr")!;
    await waitFor(() => expect(parentRow.getAttribute("aria-expanded")).toBe("false"));
    parentRow.focus();
    await user.keyboard("{ArrowRight}");
    const secondaryRow = within(screen.getByRole("grid", { name: "文献列表" })).getByText("supplement.pdf").closest("tr");
    expect(secondaryRow).toBeTruthy();
    await user.click(within(secondaryRow as HTMLElement).getByRole("button", { name: "展开条目" }));
    await user.click(screen.getByText("Annotation · p.7"));

    await waitFor(() => {
      expect(useLiteratureStore.getState().library.papers[0].pdf.path).toBe("papers/supplement.pdf");
    });
    expect(await screen.findByRole("button", { name: "返回" })).toBeTruthy();
  });

  it("does not let the retired instant-search store path bypass SearchRun", async () => {
    await act(async () => {
      await useLiteratureStore.getState().runRemoteSearch("local-first review", ["crossref"]);
    });

    expect(useLiteratureStore.getState().error).toMatch(/可复现检索/);
  });

  it("keeps papers without a direct PDF link in the library and reports the retrieval error", async () => {
    const user = userEvent.setup();
    const withoutDirectPdf = fixtureLibrary();
    withoutDirectPdf.papers[0].pdf = { status: "none" };
    mocks.literatureLoad.mockResolvedValue(withoutDirectPdf);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "获取所选论文 PDF" }));

    expect(mocks.literatureDownloadPdf).not.toHaveBeenCalled();
    expect(useStore.getState().pendingChatInput).toBeNull();
    expect(useStore.getState().tab).toBe("literature");
  });

  it("moves a paper to the trash without a confirmation prompt", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("已将 1 篇移入回收站");
    expect(screen.getByText("从第一篇文献开始")).toBeTruthy();
    await waitFor(() => expect(mocks.literatureApplyDelta).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const saved = mocks.literatureApplyDelta.mock.calls[
      mocks.literatureApplyDelta.mock.calls.length - 1
    ]?.[0] as { hidePaperIds: string[] };
    expect(saved.hidePaperIds).toEqual(["arxiv:1111.00001"]);

    await user.click(screen.getByRole("button", { name: "状态" }));
    await user.click(screen.getByRole("button", { name: "回收站 1" }));
    expect(await screen.findAllByText("Persisted Paper on Grounded Reading")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "选择 Persisted Paper on Grounded Reading" }));
    await user.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(mocks.literatureRestoreItems).toHaveBeenCalledWith(["arxiv:1111.00001"]),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("deletes a search with its exclusive papers while preserving shared results", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    const targetSearchId = "search-run:run-grounded";
    const sharedSearchId = "search-run:run-shared";
    library.papers[0].searchIds = [targetSearchId];
    const sharedPaper: LiteraturePaper = {
      ...structuredClone(fixturePaper),
      id: "arxiv:2222.00002",
      arxivId: "2222.00002",
      title: "Paper Shared by Two Search Runs",
      searchIds: [targetSearchId, sharedSearchId],
    };
    library.papers.push(sharedPaper);
    library.searches = [
      {
        id: targetSearchId,
        searchRunId: "run-grounded",
        query: "grounded screening",
        sources: ["scopus"],
        ranAt: "2026-06-01T00:00:00.000Z",
        resultCount: 2,
        newCount: 2,
      },
      {
        id: sharedSearchId,
        searchRunId: "run-shared",
        query: "shared evidence",
        sources: ["scopus"],
        ranAt: "2026-06-02T00:00:00.000Z",
        resultCount: 1,
        newCount: 1,
      },
    ];
    mocks.literatureLoad.mockResolvedValue(library);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Literature />);
    await screen.findByText("grounded screening");
    // Right-clicking the saved-search row opens a context menu anchored at
    // the cursor; the hover-revealed delete button was the previous affordance.
    const searchLabel = screen.getByText("grounded screening");
    const searchButton = searchLabel.closest("button");
    expect(searchButton).toBeTruthy();
    fireEvent.contextMenu(searchButton!, { clientX: 80, clientY: 24 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "删除搜索…" })).toBeTruthy();
    await user.click(within(menu).getByRole("menuitem", { name: "删除搜索…" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("移除仅属于该搜索的 1 篇相关文献"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("另有 1 篇同时属于其他搜索"));
    expect(screen.queryByText("grounded screening")).toBeNull();
    expect(screen.getAllByText(/已删除搜索“grounded screening”/).length).toBeGreaterThan(0);
    expect(useLiteratureStore.getState().library.searches.map((search) => search.id)).toEqual([sharedSearchId]);
    expect(useLiteratureStore.getState().library.papers.map((paper) => paper.id)).toEqual([sharedPaper.id]);
    await waitFor(() => expect(mocks.literatureApplyDelta).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const saved = mocks.literatureApplyDelta.mock.calls.at(-1)?.[0] as {
      hidePaperIds?: string[];
      projectionMetadata?: { hiddenSearchRunIds?: string[] };
    };
    expect(saved.hidePaperIds).toEqual([fixturePaper.id]);
    expect(saved.projectionMetadata?.hiddenSearchRunIds).toEqual(["run-grounded"]);
  });

  it("deletes a saved search from the inline action and reports the result", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    const searchId = "search-run:inline-delete";
    library.papers[0].searchIds = [searchId];
    library.searches = [{
      id: searchId,
      searchRunId: "run-inline-delete",
      query: "inline delete",
      sources: ["scopus"],
      ranAt: "2026-06-03T00:00:00.000Z",
      resultCount: 1,
      newCount: 1,
    }];
    mocks.literatureLoad.mockResolvedValue(library);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Literature />);
    await screen.findByText("inline delete");
    await user.click(screen.getByRole("button", { name: "inline delete 的搜索操作" }));
    await user.click(screen.getByRole("menuitem", { name: "删除搜索…" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("inline delete"));
    expect(useLiteratureStore.getState().library.searches).toEqual([]);
    expect(screen.queryByText("inline delete")).toBeNull();
    expect(screen.getAllByText(/已删除搜索“inline delete”/).length).toBeGreaterThan(0);
  });

  it("tombstones the search run of a projection that only encodes it in the id", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    // A projection written before run-mirrored saved searches were removed
    // from `library_saved_searches`: the entry names its run only through the
    // id. Without deriving the run from it, no tombstone was ever written and
    // the surviving SearchRun rebuilt the search on the next load.
    const searchId = "search-run:run-legacy-mirror";
    library.papers[0].searchIds = [searchId];
    library.searches = [{
      id: searchId,
      query: "legacy mirrored search",
      sources: ["arxiv"],
      ranAt: "2026-06-04T00:00:00.000Z",
      resultCount: 1,
      newCount: 0,
    }];
    mocks.literatureLoad.mockResolvedValue(library);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Literature />);
    await screen.findByText("legacy mirrored search");
    await user.click(screen.getByRole("button", { name: "legacy mirrored search 的搜索操作" }));
    await user.click(screen.getByRole("menuitem", { name: "删除搜索…" }));

    expect(useLiteratureStore.getState().library.searches).toEqual([]);
    await waitFor(() => expect(mocks.literatureApplyDelta).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const saved = mocks.literatureApplyDelta.mock.calls.at(-1)?.[0] as {
      projectionMetadata?: { hiddenSearchRunIds?: string[]; searches?: unknown[] };
    };
    expect(saved.projectionMetadata?.hiddenSearchRunIds).toEqual(["run-legacy-mirror"]);
    // It is run-derived state, so it must not be written back as a user-owned
    // saved search either.
    expect(saved.projectionMetadata?.searches).toEqual([]);
  });

  it("keeps a deleted search deleted when the library refreshes inside the save debounce", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    const targetSearchId = "search-run:run-grounded";
    library.papers[0].searchIds = [targetSearchId];
    library.searches = [{
      id: targetSearchId,
      searchRunId: "run-grounded",
      query: "grounded screening",
      sources: ["scopus"],
      ranAt: "2026-06-01T00:00:00.000Z",
      resultCount: 1,
      newCount: 1,
    }];
    mocks.literatureLoad.mockResolvedValue(library);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Literature />);
    await screen.findByText("grounded screening");
    const searchLabel = screen.getByText("grounded screening");
    const searchButton = searchLabel.closest("button");
    expect(searchButton).toBeTruthy();
    fireEvent.contextMenu(searchButton!, { clientX: 80, clientY: 24 });
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "删除搜索…" }));
    expect(useLiteratureStore.getState().library.searches).toEqual([]);

    // Saving is debounced, and the Literature UI refreshes itself from the
    // backend after a dozen different actions. A refresh that lands inside the
    // debounce window used to drop the pending write, and since the search run
    // still exists in the canonical store the projection put the search
    // straight back — the delete looked like it had simply been ignored.
    const projectId = useStore.getState().currentProject?.id ?? "default";
    await act(async () => {
      await useLiteratureStore.getState().load(projectId, { quiet: true });
    });

    expect(mocks.literatureApplyDelta).toHaveBeenCalled();
    const saved = mocks.literatureApplyDelta.mock.calls.at(-1)?.[0] as {
      projectionMetadata?: { hiddenSearchRunIds?: string[] };
    };
    expect(saved.projectionMetadata?.hiddenSearchRunIds).toEqual(["run-grounded"]);
  });

  it("still drops a pending save when the project changes under it", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.searches = [{
      id: "search-run:run-grounded",
      searchRunId: "run-grounded",
      query: "grounded screening",
      sources: ["scopus"],
      ranAt: "2026-06-01T00:00:00.000Z",
      resultCount: 1,
      newCount: 1,
    }];
    mocks.literatureLoad.mockResolvedValue(library);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Literature />);
    await screen.findByText("grounded screening");
    const searchLabel = screen.getByText("grounded screening");
    const searchButton = searchLabel.closest("button");
    expect(searchButton).toBeTruthy();
    fireEvent.contextMenu(searchButton!, { clientX: 80, clientY: 24 });
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "删除搜索…" }));

    // The other half of the same guard: the backend already points at the new
    // project, so flushing here would write one project's library into another.
    await act(async () => {
      await useLiteratureStore.getState().load("a-different-project", { quiet: true });
    });

    expect(mocks.literatureApplyDelta).not.toHaveBeenCalled();
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
    await generateBriefForTest(downloaded.papers[0].id);

    expect(useLiteratureStore.getState().error).toContain("全文简报生成失败");
    expect(mocks.literatureLlm).not.toHaveBeenCalled();
    expect(useLiteratureStore.getState().library.papers[0].brief).toBeUndefined();
  });

  it("refuses to present a truncated extraction as a full-text brief", async () => {
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
    await generateBriefForTest(downloaded.papers[0].id);

    expect(useLiteratureStore.getState().error).toContain("PDF 全文不完整");
    expect(mocks.literatureLlm).not.toHaveBeenCalled();
  });

  it("writes the brief with the real LLM when an executor is configured", async () => {
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
    await generateBriefForTest(downloaded.papers[0].id);

    const brief = useLiteratureStore.getState().library.papers[0].brief;
    expect(brief?.problem.text).toBe("Reviewers drown in papers.");
    expect(brief?.method.text).toBe("A staged agentic pipeline.");
    expect(mocks.literatureLlm).toHaveBeenCalled();
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
    act(() => {
      useLiteratureStore.getState().deleteEvidence(library.papers[0].id, "evidence-1");
    });

    const paper = useLiteratureStore.getState().library.papers[0];
    expect(paper.evidence).toEqual([]);
    expect(paper.answerChains).toEqual([]);
    expect(paper.pdfAnnotations).toEqual([]);
    const activity = useLiteratureStore.getState().activity;
    expect(activity[activity.length - 1]?.text).toContain("已删除第 3 页证据");
  });

  it("supports keyboard menus and restores focus after closing the creation dialog", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    const add = screen.getByRole("button", { name: "添加文献" });
    add.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /导入 PDF/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(add);
    await user.keyboard("{ArrowDown}{End}{Enter}");
    const dialog = screen.getByRole("dialog", { name: "新建文献条目" });
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "标题" }));
    within(dialog).getByRole("button", { name: "创建条目" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "关闭" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it("keeps hidden details hidden while rows are selected, and restores them on request", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers.push({ ...structuredClone(fixturePaper), id: "second", title: "Second reference", addedAt: "2026-05-01T00:00:00.000Z" });
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(within(screen.getByRole("region", { name: "文献详情" })).getByRole("button", { name: "收起详情" }));
    expect(screen.queryByRole("region", { name: "文献详情" })).toBeNull();
    expect(screen.getByRole("button", { name: "显示详情" }).getAttribute("aria-expanded")).toBe("false");

    const secondRow = screen.getByText("Second reference").closest("tr")!;
    await user.click(secondRow);
    expect(secondRow.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("region", { name: "文献详情" })).toBeNull();
    expect(useLiteratureStore.getState().library.papers[0].unread).toBe(true);

    await user.click(screen.getByRole("button", { name: "显示详情" }));
    const details = screen.getByRole("region", { name: "文献详情" });
    expect(within(details).getAllByText("Second reference").length).toBeGreaterThan(0);
  });

  it("opens the record on Enter or double-click when a paper has no PDF", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(within(screen.getByRole("region", { name: "文献详情" })).getByRole("button", { name: "收起详情" }));
    const row = screen.getByText(fixturePaper.title).closest("tr")!;
    row.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "文献详情" })).toBeTruthy();
    await user.click(within(screen.getByRole("region", { name: "文献详情" })).getByRole("button", { name: "收起详情" }));
    await user.dblClick(row);
    expect(screen.getByRole("region", { name: "文献详情" })).toBeTruthy();
  });

  it("drops hidden checked rows when changing to another collection", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers.push({ ...structuredClone(fixturePaper), id: "second", title: "A starred reference", starred: true });
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(screen.getByRole("checkbox", { name: "选择 " + fixturePaper.title }));
    expect(screen.getByRole("toolbar", { name: "批量操作" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "已收藏 1" }));
    expect(screen.queryByRole("toolbar", { name: "批量操作" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "全部论文 2" }));
    expect((screen.getByRole("checkbox", { name: "选择 " + fixturePaper.title }) as HTMLInputElement).checked).toBe(false);
  });

  it("applies advanced filters without saving a search and clears them in one action", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers.push({ ...structuredClone(fixturePaper), id: "older", title: "Older reference", year: 2019 });
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(screen.getByRole("button", { name: "高级搜索" }));
    const filters = screen.getByRole("region", { name: "高级搜索" });
    await user.selectOptions(within(filters).getByRole("combobox", { name: "搜索字段" }), "year");
    await user.selectOptions(within(filters).getByRole("combobox", { name: "匹配方式" }), "greaterThan");
    await user.type(within(filters).getByRole("textbox", { name: "条件值" }), "2020");
    await user.click(within(filters).getByRole("button", { name: "应用筛选" }));
    expect(screen.queryByText("Older reference")).toBeNull();
    expect(useLiteratureStore.getState().library.searches).toHaveLength(0);
    expect(screen.getByText("1 项高级条件")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("Older reference")).toBeTruthy();
    expect(screen.queryByText("1 项高级条件")).toBeNull();
  });

  it("scopes quick-filter counts to the collection and clears hidden selections", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.collections = [{ id: "core", label: "Core review" }];
    library.papers[0].collectionIds = ["core"];
    library.papers.push(
      { ...structuredClone(fixturePaper), id: "read", title: "Read and starred", unread: false, starred: true, collectionIds: ["core"] },
      { ...structuredClone(fixturePaper), id: "outside", title: "Outside collection", starred: true },
    );
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(screen.getByRole("button", { name: "Core review 2" }));
    const quickFilters = screen.getByRole("group", { name: "快捷筛选" });
    expect(within(quickFilters).getByRole("button", { name: "全部 2" })).toBeTruthy();
    expect(within(quickFilters).getByRole("button", { name: "已收藏 1" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "选择 " + fixturePaper.title }));
    await user.click(within(quickFilters).getByRole("button", { name: "已收藏 1" }));
    const list = screen.getByRole("grid", { name: "文献列表" });
    expect(within(list).queryByText(fixturePaper.title)).toBeNull();
    expect(within(list).queryByText("Outside collection")).toBeNull();
    expect(within(list).getByText("Read and starred")).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "批量操作" })).toBeNull();
    await user.click(within(quickFilters).getByRole("button", { name: "未读 1" }));
    expect(within(list).getByText(fixturePaper.title)).toBeTruthy();
    expect(within(list).queryByText("Read and starred")).toBeNull();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(within(list).getByText("Read and starred")).toBeTruthy();
  });

  it("uses the list for an obsolete card preference and keeps selection and keyboard actions", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers.push({ ...structuredClone(fixturePaper), id: "second", title: "Second reference" });
    mocks.literatureLoad.mockResolvedValue(library);
    localStorage.setItem("somniq-literature-layout-v1", JSON.stringify({ layout: "cards" }));
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.click(screen.getByRole("checkbox", { name: "选择 " + fixturePaper.title }));
    expect(document.querySelector(".lit-layout-list")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "选择 " + fixturePaper.title }) as HTMLInputElement).checked).toBe(true);
    const second = within(screen.getByRole("grid", { name: "文献列表" })).getByText("Second reference").closest("tr")!;
    second.focus();
    await user.keyboard(" ");
    expect((within(second).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("focuses the top search with Ctrl+K and opens a PDF from its Info file card", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers[0].pdf = { status: "downloaded", path: "papers/reading.pdf" };
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    await user.keyboard("{Control>}k{/Control}");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "筛选论文" }));
    const files = document.querySelector(".lip-reference-files") as HTMLElement;
    await user.click(within(files).getByRole("button", { name: /reading.pdf/ }));
    expect(document.querySelector(".lit-reading-shell")).toBeTruthy();
    expect(useLiteratureStore.getState().library.papers[0].unread).toBe(false);
  });

  it("uses arrow keys for the labeled detail tabs and keeps control keys out of row selection", async () => {
    const user = userEvent.setup();
    const library = fixtureLibrary();
    library.papers.push({ ...structuredClone(fixturePaper), id: "second", title: "Second reference" });
    mocks.literatureLoad.mockResolvedValue(library);
    render(<Literature />);
    await screen.findAllByText(fixturePaper.title);
    const info = screen.getByRole("tab", { name: "信息" });
    info.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "相关" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Home}");
    expect(info.getAttribute("aria-selected")).toBe("true");
    const secondRow = screen.getByText("Second reference").closest("tr")!;
    within(secondRow).getByRole("button", { name: "收藏" }).focus();
    await user.keyboard(" ");
    expect(secondRow.getAttribute("aria-selected")).toBe("false");
    expect(useLiteratureStore.getState().library.papers.find((paper) => paper.id === "second")?.starred).toBe(true);
  });

  it("batch-moves selected papers along the pipeline", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(
      screen.getByLabelText("选择 Persisted Paper on Grounded Reading"),
    );
    const batchBar = screen.getByRole("toolbar", { name: "批量操作" });
    await user.click(within(batchBar).getByRole("button", { name: "候选" }));

    await user.click(screen.getByRole("button", { name: "状态" }));
    expect(screen.getByRole("button", { name: "候选 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收件箱 0" })).toBeTruthy();
  });
  describe("list keyboard and multi-select", () => {
    const threePapers = () => {
      const library = fixtureLibrary();
      library.papers.push(
        { ...structuredClone(fixturePaper), id: "second", title: "Second reference", addedAt: "2026-05-01T00:00:00.000Z" },
        { ...structuredClone(fixturePaper), id: "third", title: "Third reference", addedAt: "2026-04-01T00:00:00.000Z" },
      );
      mocks.literatureLoad.mockResolvedValue(library);
    };
    const paperRows = () => Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.lit-row"));
    const checkedTitles = () => paperRows()
      .filter((row) => row.querySelector<HTMLInputElement>("input[type='checkbox']")?.checked)
      .map((row) => row.querySelector(".lit-row-title")?.textContent);

    it("keeps a single tab stop and moves the selection with the arrow keys", async () => {
      const user = userEvent.setup();
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      const rows = paperRows();
      expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);

      rows[0].focus();
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(rows[1]);
      expect(rows[1].getAttribute("aria-selected")).toBe("true");
      await user.keyboard("{End}");
      expect(document.activeElement).toBe(rows[2]);
      expect(rows[2].getAttribute("aria-selected")).toBe("true");
      await user.keyboard("{Home}");
      expect(document.activeElement).toBe(rows[0]);
      expect(paperRows().filter((row) => row.tabIndex === 0)).toEqual([rows[0]]);
    });

    it("ticks with Space, extends with Shift+arrow, selects all and clears with Escape", async () => {
      const user = userEvent.setup();
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      const rows = paperRows();
      const titles = rows.map((row) => row.querySelector(".lit-row-title")?.textContent);

      rows[0].focus();
      await user.keyboard(" ");
      expect(checkedTitles()).toEqual([titles[0]]);
      await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
      expect(checkedTitles()).toEqual(titles);
      await user.keyboard("{Escape}");
      expect(checkedTitles()).toEqual([]);
      expect(screen.queryByRole("toolbar", { name: "批量操作" })).toBeNull();
      await user.keyboard("{Control>}a{/Control}");
      expect(checkedTitles()).toEqual(titles);
      expect(within(screen.getByRole("toolbar", { name: "批量操作" })).getByText("已选 3 篇")).toBeTruthy();
    });

    it("ticks a run with Shift-click and toggles single rows with Ctrl-click", async () => {
      const user = userEvent.setup();
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      const rows = paperRows();
      const titles = rows.map((row) => row.querySelector(".lit-row-title")?.textContent);
      const box = (row: HTMLTableRowElement) => row.querySelector<HTMLInputElement>("input[type='checkbox']")!;

      await user.click(box(rows[0]));
      await user.keyboard("{Shift>}");
      await user.click(box(rows[2]));
      await user.keyboard("{/Shift}");
      expect(checkedTitles()).toEqual(titles);

      await user.keyboard("{Control>}");
      await user.click(rows[1]);
      await user.keyboard("{/Control}");
      expect(checkedTitles()).toEqual([titles[0], titles[2]]);

      await user.click(rows[0]);
      await user.keyboard("{Shift>}");
      await user.click(rows[1]);
      await user.keyboard("{/Shift}");
      expect(checkedTitles()).toEqual(titles);
    });

    it("clears ticks with Escape while a row checkbox has focus", async () => {
      const user = userEvent.setup();
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      await user.click(paperRows()[1].querySelector<HTMLInputElement>("input[type='checkbox']")!);
      expect(checkedTitles()).toHaveLength(1);
      await user.keyboard("{Escape}");
      expect(checkedTitles()).toEqual([]);
    });

    it("keeps the rows in place when the batch bar appears", async () => {
      const user = userEvent.setup();
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      const table = screen.getByRole("grid", { name: "文献列表" });
      const siblingsBefore = table.parentElement!.children.length;
      await user.click(paperRows()[0].querySelector<HTMLInputElement>("input[type='checkbox']")!);
      const bar = screen.getByRole("toolbar", { name: "批量操作" });
      // The bar overlays the sticky header inside the scroll area instead of
      // being inserted above it.
      expect(bar.parentElement).toBe(table.parentElement);
      expect(bar.nextElementSibling).toBe(table);
      expect(table.parentElement!.children.length).toBe(siblingsBefore + 1);
    });

    it("moves the focused paper to the trash with Delete and undoes it", async () => {
      const user = userEvent.setup();
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      const [first, second] = paperRows();
      const firstTitle = first.querySelector(".lit-row-title")?.textContent;
      const secondTitle = second.querySelector(".lit-row-title")?.textContent;

      first.focus();
      await user.keyboard("{Delete}");
      expect(confirm).not.toHaveBeenCalled();
      expect(screen.queryByText(firstTitle!)).toBeNull();
      expect((document.activeElement as HTMLElement).querySelector(".lit-row-title")?.textContent).toBe(secondTitle);
      const notice = screen.getByRole("status");
      expect(notice.textContent).toContain("已将 1 篇移入回收站");

      await user.click(within(notice).getByRole("button", { name: "撤销" }));
      await waitFor(() => expect(mocks.literatureRestoreItems).toHaveBeenCalledWith([expect.any(String)]));
      expect(screen.queryByText("已将 1 篇移入回收站")).toBeNull();
    });

    it("treats narrow-layout details as a drawer that Escape dismisses", async () => {
      class NarrowObserver {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe() {
          this.callback([{ contentRect: { width: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", NarrowObserver);
      try {
        const user = userEvent.setup();
        threePapers();
        render(<Literature />);
        await screen.findByText("Third reference");
        const rows = paperRows();
        await user.click(rows[0]);
        const details = await screen.findByRole("region", { name: "文献详情" });
        within(details).getByRole("tab", { name: "信息" }).focus();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("region", { name: "文献详情" })).toBeNull();
        expect(document.activeElement).toBe(rows[0]);

        // Browsing with the keyboard leaves the list uncovered...
        await user.keyboard("{ArrowDown}");
        expect(rows[1].getAttribute("aria-selected")).toBe("true");
        expect(screen.queryByRole("region", { name: "文献详情" })).toBeNull();
        // ...while a click still opens the drawer after it was dismissed.
        await user.click(rows[2]);
        expect(await screen.findByRole("region", { name: "文献详情" })).toBeTruthy();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("opens row actions on right-click and targets the ticked rows", async () => {
      const user = userEvent.setup();
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      const rows = paperRows();
      const titles = rows.map((row) => row.querySelector(".lit-row-title")?.textContent ?? "");

      fireEvent.contextMenu(rows[2], { clientX: 120, clientY: 140 });
      let menu = screen.getByRole("menu", { name: `“${titles[2]}”的操作` });
      expect(rows[2].getAttribute("aria-selected")).toBe("true");
      await user.click(within(menu).getByRole("menuitem", { name: "收藏" }));
      expect(useLiteratureStore.getState().library.papers.find((paper) => paper.title === titles[2])?.starred).toBe(true);
      expect(screen.queryByRole("menu")).toBeNull();

      await user.click(rows[0].querySelector<HTMLInputElement>("input[type='checkbox']")!);
      await user.click(rows[1].querySelector<HTMLInputElement>("input[type='checkbox']")!);
      fireEvent.contextMenu(rows[1], { clientX: 120, clientY: 140 });
      menu = screen.getByRole("menu", { name: "2 篇文献的操作" });
      await user.click(within(menu).getByRole("menuitem", { name: "加入候选" }));
      const stages = useLiteratureStore.getState().library.papers
        .filter((paper) => titles.slice(0, 2).includes(paper.title))
        .map((paper) => paper.stage);
      expect(stages).toEqual(["shortlist", "shortlist"]);

      // A right-click outside the ticked set replaces it with that row.
      await user.click(rows[0].querySelector<HTMLInputElement>("input[type='checkbox']")!);
      fireEvent.contextMenu(rows[2], { clientX: 120, clientY: 140 });
      expect(checkedTitles()).toEqual([]);
      menu = screen.getByRole("menu", { name: `“${titles[2]}”的操作` });
      await user.click(within(menu).getByRole("menuitem", { name: "移入回收站" }));
      expect(screen.queryByText(titles[2])).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("已将 1 篇移入回收站");
    });

    it("closes the row menu with Escape and returns focus to the row", async () => {
      const user = userEvent.setup();
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      const row = paperRows()[1];
      fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
      const menu = screen.getByRole("menu");
      expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(row);
    });

    it("sorts from the column headers and keeps missing values last", async () => {
      const user = userEvent.setup();
      const library = fixtureLibrary();
      library.papers[0] = { ...library.papers[0], title: "Beta", year: 2021, venue: "Nature" };
      library.papers.push(
        { ...structuredClone(fixturePaper), id: "alpha", title: "Alpha", year: 2024, venue: "" },
        { ...structuredClone(fixturePaper), id: "gamma", title: "Gamma", year: undefined, venue: "ACL" },
      );
      mocks.literatureLoad.mockResolvedValue(library);
      render(<Literature />);
      await screen.findByText("Gamma");
      const order = () => paperRows().map((row) => row.querySelector(".lit-row-title")?.textContent);
      const header = (name: string) => screen.getByRole("columnheader", { name });

      await user.click(within(header("年份")).getByRole("button"));
      expect(header("年份").getAttribute("aria-sort")).toBe("descending");
      expect(order()).toEqual(["Alpha", "Beta", "Gamma"]);
      await user.click(within(header("年份")).getByRole("button"));
      expect(header("年份").getAttribute("aria-sort")).toBe("ascending");
      expect(order()).toEqual(["Beta", "Alpha", "Gamma"]);

      await user.click(within(header("出版物")).getByRole("button"));
      expect(header("年份").getAttribute("aria-sort")).toBeNull();
      expect(header("出版物").getAttribute("aria-sort")).toBe("ascending");
      expect(order()).toEqual(["Gamma", "Beta", "Alpha"]);
      await user.click(within(header("出版物")).getByRole("button"));
      expect(header("出版物").getAttribute("aria-sort")).toBe("descending");
      expect(order()).toEqual(["Beta", "Gamma", "Alpha"]);

      await user.click(within(header("标题")).getByRole("button"));
      expect(order()).toEqual(["Alpha", "Beta", "Gamma"]);
    });

    it("remembers hidden details, sorting and panel widths across visits", async () => {
      const user = userEvent.setup();
      threePapers();
      const first = render(<Literature />);
      await screen.findByText("Third reference");
      await user.click(within(screen.getByRole("region", { name: "文献详情" })).getByRole("button", { name: "收起详情" }));
      await user.click(within(screen.getByRole("columnheader", { name: "标题" })).getByRole("button"));
      const divider = screen.getByRole("separator", { name: "调整导航宽度" });
      expect(divider.getAttribute("aria-valuenow")).toBe("268");
      divider.focus();
      await user.keyboard("{ArrowRight}{ArrowRight}");
      expect(divider.getAttribute("aria-valuenow")).toBe("300");
      await waitFor(() => expect(JSON.parse(localStorage.getItem("somniq-literature-layout-v1") ?? "{}")).toMatchObject({
        detailsHidden: true,
        sort: "title",
        sidebarWidth: 300,
      }));
      first.unmount();

      render(<Literature />);
      await screen.findByText("Third reference");
      expect(screen.queryByRole("region", { name: "文献详情" })).toBeNull();
      expect(screen.getByRole("columnheader", { name: "标题" }).getAttribute("aria-sort")).toBe("ascending");
      const restored = screen.getByRole("separator", { name: "调整导航宽度" });
      expect(restored.getAttribute("aria-valuenow")).toBe("300");
      await user.dblClick(restored);
      expect(restored.getAttribute("aria-valuenow")).toBe("268");
    });

    it("ignores unreadable stored layout", async () => {
      localStorage.setItem("somniq-literature-layout-v1", "{not json");
      threePapers();
      render(<Literature />);
      await screen.findByText("Third reference");
      expect(screen.getByRole("region", { name: "文献详情" })).toBeTruthy();
      expect(screen.getByRole("separator", { name: "调整导航宽度" }).getAttribute("aria-valuenow")).toBe("268");
    });

    it("opens the PDF on double-click even where the drawer would cover the row", async () => {
      class NarrowObserver {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe() {
          this.callback([{ contentRect: { width: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", NarrowObserver);
      try {
        const user = userEvent.setup();
        const library = fixtureLibrary();
        library.papers[0].pdf = { status: "downloaded", path: "papers/1111.00001.pdf" };
        mocks.literatureLoad.mockResolvedValue(library);
        render(<Literature />);
        await screen.findAllByText(fixturePaper.title);
        await user.click(within(screen.getByRole("region", { name: "文献详情" })).getByRole("button", { name: "收起详情" }));
        const row = paperRows()[0];
        // The first click must not put the drawer over the row before the
        // second click of the double-click arrives.
        fireEvent.click(row, { detail: 1 });
        expect(screen.queryByRole("region", { name: "文献详情" })).toBeNull();
        fireEvent.click(row, { detail: 2 });
        fireEvent.doubleClick(row, { detail: 2 });
        expect(screen.getByRole("tablist", { name: "已打开的 PDF" })).toBeTruthy();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("focuses the library search with the slash key", async () => {
      const user = userEvent.setup();
      render(<Literature />);
      await screen.findAllByText(fixturePaper.title);
      await user.keyboard("/");
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "筛选论文" }));
    });
  });
});
