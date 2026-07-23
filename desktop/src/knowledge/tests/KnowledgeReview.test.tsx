// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  knowledgeLoad: vi.fn(),
  knowledgeSearch: vi.fn(),
  knowledgeUpsert: vi.fn(),
  knowledgeConfirm: vi.fn(),
  knowledgeReject: vi.fn(),
  knowledgeGenerate: vi.fn(),
  literatureLlm: vi.fn(),
  literatureRagStatus: vi.fn(),
  literatureLoad: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  isTauri: () => true,
  knowledgeLoad: mocks.knowledgeLoad,
  knowledgeSearch: mocks.knowledgeSearch,
  knowledgeUpsert: mocks.knowledgeUpsert,
  knowledgeConfirm: mocks.knowledgeConfirm,
  knowledgeReject: mocks.knowledgeReject,
  knowledgeGenerate: mocks.knowledgeGenerate,
  literatureLlm: mocks.literatureLlm,
  literatureRagStatus: mocks.literatureRagStatus,
  literatureLoad: mocks.literatureLoad,
}));

import Knowledge from "../KnowledgeReview";
import { resetKnowledgeStore } from "../knowledgeStore";
import { useStore } from "../../store";

const draft = {
  id: "kp-d1",
  question: "Q draft?",
  answer: "A draft.",
  statement: "Draft statement one.",
  kind: "finding",
  status: "draft",
  sourcePaperId: "arxiv:1",
  evidence: [{ paperId: "arxiv:1", page: 4, quote: "grounded span", annotationId: "ann-1" }],
};
const confirmedPoint = {
  id: "kp-c1",
  question: "Q confirmed?",
  answer: "A confirmed.",
  statement: "Confirmed statement.",
  kind: "method",
  status: "confirmed",
  sourcePaperId: "arxiv:1",
  evidence: [{ paperId: "arxiv:1", page: 2, quote: "another span" }],
};
const libraryPaper = {
  id: "arxiv:1",
  title: "Paper One",
  stage: "read",
  brief: {},
  evidence: [
    {
      id: "ev-1",
      page: 4,
      quote: "grounded span",
      note: "Evidence note becomes a knowledge fragment.",
      source: "vision",
    },
  ],
  answerChains: [
    {
      id: "chain-1",
      question: "What does the evidence imply?",
      answer: "Evidence implies a reusable reading conclusion.",
      reviewStatus: "accepted",
      supports: [{ annotationId: "ann-1", role: "result" }],
    },
  ],
  pdfAnnotations: [
    {
      id: "ann-1",
      page: 4,
      quote: "grounded span",
      note: "result support",
      evidenceId: "ev-1",
    },
  ],
};

beforeEach(() => {
  resetKnowledgeStore();
  useStore.setState({
    tab: "literature",
    currentProject: {
      id: "project-test",
      name: "Test",
      path: "C:/project",
      addedAt: 0,
      lastOpenedAt: 0,
    },
  });
  mocks.knowledgeLoad.mockReset().mockResolvedValue({ points: [draft, confirmedPoint] });
  mocks.literatureLoad
    .mockReset()
    .mockResolvedValue({ papers: [libraryPaper] });
  mocks.knowledgeSearch.mockReset().mockResolvedValue({ results: [] });
  mocks.knowledgeUpsert.mockReset().mockResolvedValue({ ids: [] });
  mocks.knowledgeConfirm.mockReset().mockResolvedValue(undefined);
  mocks.knowledgeReject.mockReset().mockResolvedValue(true);
  mocks.knowledgeGenerate.mockReset().mockResolvedValue({ candidates: [] });
  mocks.literatureRagStatus.mockReset().mockResolvedValue({
    exists: true,
    cardPreviews: [{
      chunkId: "chunk-card-1",
      paperId: "arxiv:1",
      relativePath: "papers/paper-one.pdf",
      pageStart: 6,
      pageEnd: 6,
      updatedAt: "2026-07-22T00:00:00Z",
      sourcePreview: "The method is evaluated on a small benchmark.",
      card: {
        chunkId: "chunk-card-1",
        sourceContentHash: "hash-1",
        questions: ["Which benchmark evaluates the method?"],
        concepts: ["benchmark evaluation"],
        sectionHeadings: ["Evaluation"],
        aliases: ["evaluation suite"],
        methods: ["local retrieval"],
        datasets: ["small benchmark"],
        metrics: [],
        limitations: [],
        languageTerms: ["基准评估"],
        generatedBy: "MiniMax-M3",
        promptVersion: 1,
      },
    }],
  });
  mocks.literatureLlm.mockReset().mockResolvedValue(JSON.stringify({
    categories: [
      {
        label: "Agent 大类",
        children: [
          {
            label: "Agent 小类",
            itemIds: ["arxiv:1:evidence:ev-1", "kp-c1"],
          },
        ],
      },
    ],
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Knowledge review", () => {
  it("shows literature evidence and answer chains as knowledge fragments by default", async () => {
    render(<Knowledge />);
    expect(await screen.findByText("Evidence note becomes a knowledge fragment.")).toBeTruthy();
    expect(screen.getByText("What does the evidence imply?")).toBeTruthy();
    expect(screen.getByText("Evidence implies a reusable reading conclusion.")).toBeTruthy();
  });

  it("scopes the paper knowledge workflow to the selected paper", async () => {
    const user = userEvent.setup();
    mocks.knowledgeLoad.mockResolvedValue({
      points: [
        draft,
        confirmedPoint,
        {
          id: "kp-other",
          question: "Other Q?",
          answer: "Other A.",
          statement: "Other paper draft.",
          status: "draft",
          sourcePaperId: "arxiv:2",
          evidence: [{ paperId: "arxiv:2", page: 1, quote: "other span" }],
        },
      ],
    });
    mocks.literatureLoad.mockResolvedValue({
      papers: [
        libraryPaper,
        {
          ...libraryPaper,
          id: "arxiv:2",
          title: "Paper Two",
          evidence: [{
            id: "ev-other",
            page: 1,
            quote: "other span",
            note: "Other paper fragment.",
            source: "text",
          }],
          answerChains: [],
          pdfAnnotations: [],
        },
      ],
    });

    render(<Knowledge initialPaperId="arxiv:1" />);
    expect(await screen.findByText("Evidence note becomes a knowledge fragment.")).toBeTruthy();
    expect(screen.queryByText("Other paper fragment.")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^待审核/ }));
    expect(await screen.findByText("Draft statement one.")).toBeTruthy();
    expect(screen.queryByText("Other paper draft.")).toBeNull();
  });

  it("shows draft cards with anchored evidence and the confirm/refine/reject actions", async () => {
    const user = userEvent.setup();
    render(<Knowledge />);
    await user.click(await screen.findByRole("button", { name: /^待审核/ }));
    expect(await screen.findByText("Draft statement one.")).toBeTruthy();
    expect(screen.getByText("[arxiv:1 p.4]")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^确认/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /修改/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /丢弃/ })).toBeTruthy();
  });

  it("confirms a draft through the user action path and surfaces it in the confirmed list", async () => {
    const user = userEvent.setup();
    render(<Knowledge />);
    await user.click(await screen.findByRole("button", { name: /^待审核/ }));
    await screen.findByText("Draft statement one.");

    await user.click(screen.getByRole("button", { name: /^确认/ }));
    await waitFor(() => expect(mocks.knowledgeConfirm).toHaveBeenCalledWith("kp-d1"));

    await user.click(screen.getByRole("button", { name: /^已确认/ }));
    expect(await screen.findByText("Confirmed statement.")).toBeTruthy();
    expect(screen.getByText("Draft statement one.")).toBeTruthy();
  });

  it("rejects a draft and removes it from the review queue", async () => {
    const user = userEvent.setup();
    render(<Knowledge />);
    await user.click(await screen.findByRole("button", { name: /^待审核/ }));
    await screen.findByText("Draft statement one.");

    await user.click(screen.getByRole("button", { name: /丢弃/ }));
    await waitFor(() => expect(mocks.knowledgeReject).toHaveBeenCalledWith("kp-d1"));
    await waitFor(() =>
      expect(screen.queryByText("Draft statement one.")).toBeNull(),
    );
  });

  it("generates draft candidates from a read paper", async () => {
    const user = userEvent.setup();
    mocks.knowledgeGenerate.mockResolvedValue({
      candidates: [
        {
          id: "kp-new",
          question: "Generated Q?",
          answer: "Generated A.",
          statement: "Generated statement.",
          status: "draft",
          evidence: [{ paperId: "arxiv:1", page: 1, quote: "src" }],
        },
      ],
    });
    render(<Knowledge />);
    await screen.findByText("Evidence note becomes a knowledge fragment.");

    await user.click(screen.getByRole("button", { name: /生成知识点/ }));
    await waitFor(() => expect(mocks.knowledgeGenerate).toHaveBeenCalledWith("arxiv:1"));

    // The new candidate joins the review queue (only the current card renders,
    // so assert the queue grew from 1 to 2 via the Review tab count).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^待审核/ }).textContent).toContain("2"),
    );
  });

  it("defaults generation to the paper passed by the literature workspace", async () => {
    const user = userEvent.setup();
    mocks.literatureLoad.mockResolvedValue({
      papers: [
        { id: "arxiv:2", title: "Paper Two", stage: "read", brief: {} },
        libraryPaper,
      ],
    });

    render(<Knowledge initialPaperId="arxiv:1" />);
    await screen.findByText("Evidence note becomes a knowledge fragment.");

    await user.click(screen.getByRole("button", { name: /生成知识点/ }));
    await waitFor(() => expect(mocks.knowledgeGenerate).toHaveBeenCalledWith("arxiv:1"));
  });

  it("organizes fragments and confirmed points in the graph view", async () => {
    const user = userEvent.setup();
    render(<Knowledge mode="globalGraph" />);

    const graph = await screen.findByLabelText("知识图谱");
    expect(graph).toBeTruthy();
    expect(within(graph).getAllByText("全局知识图谱").length).toBeGreaterThanOrEqual(1);
    expect(within(graph).queryByText("Evidence note becomes a knowledge fragment.")).toBeNull();
    expect(within(graph).getByText("证据片段")).toBeTruthy();
    expect(within(graph).getByText("问答结论")).toBeTruthy();
    expect(await within(graph).findByText("检索卡（非证据）")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "显示知识节点" }));
    expect(within(graph).getByText("Evidence note becomes a knowledge fragment.")).toBeTruthy();
    expect(within(graph).getByText("Confirmed statement.")).toBeTruthy();
    expect(within(graph).getByText("Which benchmark evaluates the method?")).toBeTruthy();
    expect(graph.querySelector(".kb-graph-node.retrieval-card")).toBeTruthy();
    expect(mocks.literatureRagStatus).toHaveBeenCalledWith(100);
    expect(graph.querySelector(".kb-graph-edges path")).toBeTruthy();
    expect(graph.querySelector(".kb-graph-paper-node")).toBeNull();
    expect(screen.queryByRole("button", { name: /生成知识点/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^待审核/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("125%")).toBeTruthy();
  });

  it("lets the agent rebuild the global graph taxonomy", async () => {
    const user = userEvent.setup();
    render(<Knowledge mode="globalGraph" />);
    await screen.findByLabelText("知识图谱");

    await user.click(screen.getByRole("button", { name: /Agent 重构图谱/ }));

    await waitFor(() => expect(mocks.literatureLlm).toHaveBeenCalled());
    const graph = await screen.findByLabelText("知识图谱");
    expect(within(graph).getByText("Agent 大类")).toBeTruthy();
    expect(within(graph).getByText("Agent 小类")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "显示知识节点" }));
    expect(within(graph).getByText("Evidence note becomes a knowledge fragment.")).toBeTruthy();
    expect(within(graph).getByText("Confirmed statement.")).toBeTruthy();
  });
});
