// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiteratureLibrary, LiteraturePaper } from "./literatureTypes";

const mocks = vi.hoisted(() => ({
  literatureLoad: vi.fn(),
  literatureSave: vi.fn(),
  literatureSearch: vi.fn(),
  literatureDownloadPdf: vi.fn(),
  literatureLlm: vi.fn(),
  literaturePdfText: vi.fn(),
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
  literatureDownloadPdf: mocks.literatureDownloadPdf,
  literatureLlm: mocks.literatureLlm,
  literaturePdfText: mocks.literaturePdfText,
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

import Literature from "./Literature";
import { resetLiteratureStore } from "./literatureStore";
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
  // Default: no executor configured, so screening/brief fall back to the
  // offline heuristic. Individual tests opt into the LLM path.
  mocks.literatureLlm.mockReset().mockRejectedValue(new Error("no executor configured"));
  mocks.literaturePdfText.mockReset().mockRejectedValue(new Error("no pdf text"));
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

    expect(await screen.findByText("PDF 已保存")).toBeTruthy();
    expect(mocks.literatureDownloadPdf).toHaveBeenCalledWith(
      "https://arxiv.org/pdf/1111.00001.pdf",
      "1111.00001.pdf",
    );
    expect(screen.getByText("1 paper · 1 PDF")).toBeTruthy();
    expect(screen.getByRole("button", { name: "已下载 1" })).toBeTruthy();
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

  it("generates a structured abstract brief with source tags", async () => {
    const user = userEvent.setup();
    const withAbstract = fixtureLibrary();
    withAbstract.papers[0].abstract =
      "Screening is hard. We propose a staged pipeline for triage. It reaches 0.94 recall at 8x less reading time. A limitation is the CS-only evaluation.";
    withAbstract.projectFocus = {
      question: "agent screening of literature",
      motivation: "",
      scope: "screening, triage",
      currentAssumptions: "",
    };
    mocks.literatureLoad.mockResolvedValue(withAbstract);

    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    // Brief is the default detail tab; generate from the abstract.
    await user.click(screen.getByRole("button", { name: "从摘要生成简报" }));

    // No executor configured → heuristic brief from the abstract.
    expect(await screen.findByText(/staged pipeline for triage/)).toBeTruthy();
    const detail = document.querySelector(".lit-brief") as HTMLElement;
    expect(within(detail).getByText(/0\.94 recall/)).toBeTruthy();
    expect(within(detail).getByText(/CS-only evaluation/)).toBeTruthy();
    // Every line is provenance-tagged to the abstract.
    expect(within(detail).getAllByText("[abstract]").length).toBe(4);
  });

  it("writes the brief with the real LLM when an executor is configured", async () => {
    const user = userEvent.setup();
    mocks.literatureLlm.mockResolvedValue(
      JSON.stringify({
        problem: "Reviewers drown in papers.",
        method: "A staged agentic pipeline.",
        results: "Reaches 0.94 recall at 8x less reading.",
        limits: "Evaluated on CS corpora only.",
        forYou: "Direct precedent for your screening queue.",
      }),
    );
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");
    await user.click(screen.getByRole("button", { name: "从摘要生成简报" }));

    expect(await screen.findByText("Reviewers drown in papers.")).toBeTruthy();
    const detail = document.querySelector(".lit-brief") as HTMLElement;
    expect(within(detail).getByText("A staged agentic pipeline.")).toBeTruthy();
    expect(mocks.literatureLlm).toHaveBeenCalled();
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
