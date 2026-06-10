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
  onChatDone: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  literatureLoad: mocks.literatureLoad,
  literatureSave: mocks.literatureSave,
  literatureSearch: mocks.literatureSearch,
  literatureDownloadPdf: mocks.literatureDownloadPdf,
  onChatDone: mocks.onChatDone,
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
});

beforeEach(() => {
  resetLiteratureStore();
  useStore.setState({ tab: "literature", pendingChatInput: null });
  chatDoneHandler = null;
  mocks.onChatDone.mockReset().mockImplementation((handler: (text: string) => void) => {
    chatDoneHandler = handler;
    return Promise.resolve(() => {});
  });
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
  });
  mocks.literatureDownloadPdf.mockReset().mockResolvedValue({
    path: "C:/project/papers/1111.00001.pdf",
    relativePath: "papers/1111.00001.pdf",
    bytes: 123456,
  });
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
    expect(screen.getByRole("button", { name: "Inbox 1" })).toBeTruthy();
    expect(screen.getByText("1 paper · 0 PDFs")).toBeTruthy();
  });

  it("runs a remote search, dedupes into the library, and persists", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.type(
      screen.getByLabelText("Remote search query"),
      "retrieval agents",
    );
    await user.click(screen.getByRole("button", { name: "Quick lookup" }));

    expect(
      await screen.findAllByText("Deep Retrieval Agents for Literature Triage"),
    ).toBeTruthy();
    expect(mocks.literatureSearch).toHaveBeenCalledWith(
      "retrieval agents",
      ["arxiv", "crossref"],
    );
    // One of the two results matched the stored record: only one new paper.
    expect(screen.getByText(/2 results · 1 new in Inbox/)).toBeTruthy();
    // The saved search shows up in the nav with both provenance hits.
    expect(screen.getByRole("button", { name: "retrieval agents 2" })).toBeTruthy();
    // The duplicate was enriched, not duplicated.
    expect(screen.getByText("2 papers · 0 PDFs")).toBeTruthy();
    await waitFor(() => expect(mocks.literatureSave).toHaveBeenCalled(), {
      timeout: 2000,
    });
  });

  it("downloads a PDF through the backend and records the local path", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(screen.getByRole("button", { name: "Download PDF" }));

    expect(await screen.findByText("PDF saved")).toBeTruthy();
    expect(mocks.literatureDownloadPdf).toHaveBeenCalledWith(
      "https://arxiv.org/pdf/1111.00001.pdf",
      "1111.00001.pdf",
    );
    expect(screen.getByText("1 paper · 1 PDF")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Downloaded 1" })).toBeTruthy();
  });

  it("dispatches the selected literature skill to Chat for agent search", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.type(
      screen.getByLabelText("Remote search query"),
      "retrieval agents",
    );
    await user.click(screen.getByRole("button", { name: "Agent search" }));
    expect(useStore.getState().pendingChatInput).toBe('/arxiv "retrieval agents" - max: 20');
    expect(useStore.getState().tab).toBe("chat");

    useStore.setState({ tab: "literature", pendingChatInput: null });
    await user.selectOptions(
      screen.getByLabelText("Literature skill"),
      "research-lit",
    );
    await user.click(screen.getByRole("button", { name: "Agent search" }));
    expect(useStore.getState().pendingChatInput).toBe('/research-lit "retrieval agents"');
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

  it("batch-moves selected papers along the pipeline", async () => {
    const user = userEvent.setup();
    render(<Literature />);
    await screen.findAllByText("Persisted Paper on Grounded Reading");

    await user.click(
      screen.getByLabelText("Select Persisted Paper on Grounded Reading"),
    );
    const batchBar = screen.getByRole("toolbar", { name: "Batch actions" });
    await user.click(within(batchBar).getByRole("button", { name: "Shortlist" }));

    expect(screen.getByRole("button", { name: "Shortlist 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inbox 0" })).toBeTruthy();
  });
});
