// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import type { WorkTask, WorkTaskSnapshot } from "../types";
import Tasks from "./Tasks";

const tasksStyles = readFileSync(resolve(process.cwd(), "src/tasks/Tasks.css"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const tasksSource = readFileSync(resolve(process.cwd(), "src/tasks/Tasks.tsx"), "utf8");

const {
  workTaskSnapshot,
  workTaskCreate,
  workTaskCreateAndStart,
  workTaskPause,
  workTaskReply,
  workTaskResume,
  workTaskReviewSnapshot,
  workTaskReviewPatch,
} = vi.hoisted(() => ({
  workTaskSnapshot: vi.fn<() => Promise<WorkTaskSnapshot>>(),
  workTaskCreate: vi.fn(),
  workTaskCreateAndStart: vi.fn(),
  workTaskPause: vi.fn(),
  workTaskReply: vi.fn(),
  workTaskResume: vi.fn(),
  workTaskReviewSnapshot: vi.fn(),
  workTaskReviewPatch: vi.fn(),
}));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    isTauri: () => true,
    workTaskSnapshot,
    workTaskList: vi.fn(),
    workTaskCreate,
    workTaskCreateAndStart,
    workTaskUpdate: vi.fn(),
    workTaskDelete: vi.fn(),
    workTaskStart: vi.fn(),
    workTaskPause,
    workTaskResume,
    workTaskReply,
    workTaskCancel: vi.fn(),
    workTaskReturnToTodo: vi.fn(),
    workTaskAccept: vi.fn(),
    workTaskReviewSnapshot,
    workTaskReviewPatch,
  };
});

/** The component reads the snapshot, so every fixture has to carry a revision
 *  — a board that never advances it would discard every change event. */
function snapshot(tasks: WorkTask[], revision = 1): WorkTaskSnapshot {
  return { revision, tasks };
}

vi.mock("../api/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/transport")>();
  return { ...actual, listen: vi.fn(async () => () => undefined) };
});

function task(overrides: Partial<WorkTask> & { id: string }): WorkTask {
  return {
    title: overrides.id,
    prompt: "Do the work",
    status: "todo",
    sortOrder: 0,
    runSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useStore.setState({
    language: "en",
    currentProject: {
      id: "project-a",
      name: "Project A",
      path: "C:/Project-A",
      addedAt: 1,
      lastOpenedAt: 1,
    },
    error: null,
  });
});

afterEach(cleanup);

describe("Tasks", () => {
  it("loads the task stylesheet from the eager app shell", () => {
    expect(appSource).toContain('import "./tasks/Tasks.css";');
    expect(tasksSource).not.toMatch(/^import\s+["']\.\/Tasks\.css["'];/m);
  });

  it("subscribes before its first snapshot and keeps a polling backstop", () => {
    const subscribe = tasksSource.indexOf("stop = await onWorkTaskChanged");
    const firstSnapshot = tasksSource.indexOf("await refresh();", subscribe);

    expect(subscribe).toBeGreaterThan(-1);
    expect(firstSnapshot).toBeGreaterThan(subscribe);
    expect(tasksSource).toContain("snapshot.revision < revision.current");
    expect(tasksSource).toContain("window.setInterval(() => void refresh(), BOARD_POLL_MS)");
  });

  it("labels the review column as pending confirmation in Chinese", async () => {
    useStore.setState({ language: "cn" });
    workTaskSnapshot.mockResolvedValue(snapshot([task({ id: "todo-task" })]));

    render(<Tasks />);

    expect(await screen.findByRole("heading", { name: "待确认" })).toBeTruthy();
    expect(screen.getByText("没有待确认的任务")).toBeTruthy();
  });

  it("renders the four-stage board inside Chat and opens a task transcript", async () => {
    const review = task({
      id: "task-review",
      title: "Review me",
      status: "review",
      sessionId: "work-task-task-review-1",
      changes: { filesChanged: 2, additions: 14, deletions: 3 },
    });
    workTaskSnapshot.mockResolvedValue(snapshot([review]));
    workTaskReviewSnapshot.mockResolvedValue({
      baseSha: "aaaaaaaaaa",
      headSha: "bbbbbbbbbb",
      capturedAt: 1,
      files: [
        {
          path: "survey.tex",
          changeKind: "modified",
          additions: 14,
          deletions: 3,
        },
      ],
    });
    workTaskReviewPatch.mockResolvedValue("diff --git a/survey.tex b/survey.tex");
    const onOpenSession = vi.fn();

    render(<Tasks onOpenSession={onOpenSession} />);

    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "In progress" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
    expect(tasksStyles).toMatch(/\.tasks-board\s*\{[^}]*display:\s*grid/s);
    expect(screen.getByText("2 files · +14 −3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Open chat/ }));
    expect(onOpenSession).toHaveBeenCalledWith(review);

    // The panel lists files first; the patch is fetched only for the file the
    // user opens, which is what keeps a large result reviewable.
    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    await waitFor(() => expect(workTaskReviewSnapshot).toHaveBeenCalledWith(review.id));
    expect(await screen.findByText("survey.tex")).toBeTruthy();
    expect(workTaskReviewPatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /survey\.tex/ }));
    await waitFor(() =>
      expect(workTaskReviewPatch).toHaveBeenCalledWith(review.id, "survey.tex"),
    );
    expect(await screen.findByText(/diff --git a\/survey\.tex/)).toBeTruthy();
  });

  /**
   * The regression that motivated the structured snapshot: a task that
   * produced a PDF rendered as "no changes were produced", because a binary
   * file has no text patch.
   */
  it("names a binary result instead of reporting it as no changes", async () => {
    const review = task({ id: "task-pdf", title: "Build the poster", status: "review" });
    workTaskSnapshot.mockResolvedValue(snapshot([review]));
    workTaskReviewSnapshot.mockResolvedValue({
      baseSha: "aaaaaaaaaa",
      headSha: "bbbbbbbbbb",
      capturedAt: 1,
      files: [
        {
          path: "poster.pdf",
          changeKind: "added",
          binary: true,
          byteSize: 2_411_724,
        },
      ],
    });

    render(<Tasks />);
    fireEvent.click(await screen.findByRole("button", { name: "View diff" }));

    expect(await screen.findByText("poster.pdf")).toBeTruthy();
    expect(screen.getByText(/binary · 2\.3 MB/)).toBeTruthy();
    expect(screen.queryByText("No changes were produced")).toBeNull();
    // Opening it must not ask for a patch that cannot exist.
    fireEvent.click(screen.getByRole("button", { name: /poster\.pdf/ }));
    expect(await screen.findByText(/no readable text diff/)).toBeTruthy();
    expect(workTaskReviewPatch).not.toHaveBeenCalled();
  });

  /**
   * "Write me a report" produces an empty diff and a real file. Before the
   * artifact store the file was a commit in a hidden directory and the card
   * said nothing was produced; now the diff is correctly empty, says why, and
   * the deliverable is listed beside it with a way out that is not a merge.
   */
  it("lists a standalone deliverable beside an empty diff", async () => {
    const review = task({ id: "task-report", title: "Write the report", status: "review" });
    workTaskSnapshot.mockResolvedValue(snapshot([review]));
    workTaskReviewSnapshot.mockResolvedValue({
      baseSha: "aaaaaaaaaa",
      headSha: "bbbbbbbbbb",
      capturedAt: 1,
      files: [],
      emptyReason: "artifacts_only",
      artifacts: [
        {
          id: "art-1",
          relativePath: "report.pdf",
          title: "report.pdf",
          managedPath: "C:/store/report.pdf",
          byteSize: 51_200,
          sha256: "abc",
          createdAt: 1,
        },
      ],
    });

    render(<Tasks />);
    fireEvent.click(await screen.findByRole("button", { name: "View diff" }));

    expect(await screen.findByText("Deliverables")).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("50 KB")).toBeTruthy();
    // Said out loud: accepting the merge does nothing to these.
    expect(screen.getByText(/not in the repository/)).toBeTruthy();
    expect(screen.getByText(/No repository files changed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export..." })).toBeTruthy();
  });

  /**
   * The executor's own summary used to be the only quality signal on a card.
   * The verdict is shown first, and an unchecked result is rendered as its own
   * thing rather than as a pass.
   */
  it("shows the independent verdict and what is still outstanding", async () => {
    const review = task({
      id: "task-reviewed",
      title: "Rewrite section 3",
      status: "review",
      reviewState: {
        round: 2,
        maxRounds: 2,
        verdict: "revise",
        summary: "The summary claims more than the diff contains.",
        exhausted: true,
        reviewerModel: "reviewer-model",
        checkedAt: 1,
        issues: [
          {
            severity: "high",
            title: "Section 3 was not touched",
            detail: "Only section 2 changed.",
            recommendation: "Rewrite section 3, or correct the summary.",
          },
        ],
      },
    });
    workTaskSnapshot.mockResolvedValue(snapshot([review]));
    workTaskReviewSnapshot.mockResolvedValue({
      baseSha: "aaaaaaaaaa",
      headSha: "bbbbbbbbbb",
      capturedAt: 1,
      files: [{ path: "section2.tex", changeKind: "modified", additions: 3, deletions: 1 }],
      artifacts: [],
    });

    render(<Tasks />);
    fireEvent.click(await screen.findByRole("button", { name: "View diff" }));

    expect(await screen.findByText("Independent review asked for changes")).toBeTruthy();
    expect(screen.getByText("Section 3 was not touched")).toBeTruthy();
    expect(screen.getByText("Rewrite section 3, or correct the summary.")).toBeTruthy();
    // Rounds ran out — said plainly, because the user is now the one judging.
    expect(screen.getByText(/2 revision rounds were spent/)).toBeTruthy();
    // And who checked it, since the executor is not allowed to check itself.
    expect(screen.getByText("reviewer-model")).toBeTruthy();
  });

  /** A result nobody checked must not read as one that passed. */
  it("says plainly when no independent review ran", async () => {
    const review = task({
      id: "task-unchecked",
      status: "review",
      reviewState: {
        round: 1,
        maxRounds: 2,
        verdict: "unavailable",
        summary: "No Reviewer is configured in SomniQ settings.",
        exhausted: false,
        reviewerModel: "",
        checkedAt: 1,
        issues: [],
      },
    });
    workTaskSnapshot.mockResolvedValue(snapshot([review]));
    workTaskReviewSnapshot.mockResolvedValue({
      baseSha: "a",
      headSha: "b",
      capturedAt: 1,
      files: [{ path: "a.tex", changeKind: "modified", additions: 1, deletions: 0 }],
      artifacts: [],
    });

    render(<Tasks />);
    fireEvent.click(await screen.findByRole("button", { name: "View diff" }));

    expect(await screen.findByText("Not independently reviewed")).toBeTruthy();
    expect(screen.queryByText("Passed independent review")).toBeNull();
  });

  /**
   * Fixing the panel is not enough if the card above it still lies. A task
   * that produced a report changes zero repository files, and the card face
   * used to announce "No changes were produced" regardless of what the panel
   * went on to list.
   */
  it("does not say a deliverable-only result produced no changes", async () => {
    workTaskSnapshot.mockResolvedValue(
      snapshot([
        task({
          id: "task-report-card",
          title: "Write the report",
          status: "review",
          changes: { filesChanged: 0, additions: 0, deletions: 0 },
          reviewSnapshot: {
            baseSha: "a",
            headSha: "b",
            capturedAt: 1,
            files: [],
            emptyReason: "artifacts_only",
            artifacts: [
              {
                id: "art-1",
                relativePath: "report.pdf",
                title: "report.pdf",
                managedPath: "C:/store/report.pdf",
                byteSize: 1024,
                sha256: "abc",
                createdAt: 1,
              },
            ],
          },
        }),
      ]),
    );

    render(<Tasks />);

    expect(await screen.findByText("1 deliverable")).toBeTruthy();
    expect(screen.queryByText("No changes were produced")).toBeNull();
  });

  /** An analysis-only run and an unreadable one are also distinct here. */
  it("distinguishes an analysis-only run from an unreadable one on the card", async () => {
    workTaskSnapshot.mockResolvedValue(
      snapshot([
        task({
          id: "task-analysis",
          status: "review",
          changes: { filesChanged: 0, additions: 0, deletions: 0 },
          reviewSnapshot: {
            baseSha: "a",
            headSha: "b",
            capturedAt: 1,
            files: [],
            artifacts: [],
            emptyReason: "no_repository_changes",
          },
        }),
        task({
          id: "task-lost",
          status: "review",
          changes: { filesChanged: 0, additions: 0, deletions: 0 },
          reviewSnapshot: {
            baseSha: "a",
            headSha: "",
            capturedAt: 1,
            files: [],
            artifacts: [],
            emptyReason: "worktree_missing",
          },
        }),
      ]),
    );

    render(<Tasks />);

    expect(await screen.findByText(/No repository files changed/)).toBeTruthy();
    expect(screen.getByText(/Result cannot be read/)).toBeTruthy();
  });

  /** Five different empty results used to share one misleading sentence. */
  it("says which kind of empty an empty result is", async () => {
    const review = task({ id: "task-empty", title: "Just read", status: "review" });
    workTaskSnapshot.mockResolvedValue(snapshot([review]));
    workTaskReviewSnapshot.mockResolvedValue({
      baseSha: "aaaaaaaaaa",
      headSha: "bbbbbbbbbb",
      capturedAt: 1,
      files: [],
      emptyReason: "no_repository_changes",
    });

    render(<Tasks />);
    fireEvent.click(await screen.findByRole("button", { name: "View diff" }));
    expect(await screen.findByText(/changed no files/)).toBeTruthy();

    // And an unreadable result is not the same claim at all.
    cleanup();
    workTaskReviewSnapshot.mockResolvedValue({
      baseSha: "aaaaaaaaaa",
      headSha: "",
      capturedAt: 1,
      files: [],
      emptyReason: "worktree_missing",
    });
    render(<Tasks />);
    fireEvent.click(await screen.findByRole("button", { name: "View diff" }));
    expect(await screen.findByText(/worktree is gone from disk/)).toBeTruthy();
  });

  /** Describing a task is asking for it to run. Creating a card that then sits
   *  there until a second click was a step nobody wanted. */
  it("creates and starts by default, and saves to to-do only on request", async () => {
    workTaskSnapshot.mockResolvedValue(snapshot([]));
    workTaskCreateAndStart.mockResolvedValue(task({ id: "new-task", title: "Index papers" }));
    workTaskCreate.mockResolvedValue(task({ id: "saved-task", title: "Index papers" }));

    render(<Tasks />);
    await screen.findByText("No tasks yet");

    const openDraft = async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /New task/ })[0]);
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
        target: { value: "Index papers" },
      });
      fireEvent.change(screen.getByPlaceholderText(/Describe the work/), {
        target: { value: "Index the project literature." },
      });
    };

    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
    await waitFor(() =>
      expect(workTaskCreateAndStart).toHaveBeenCalledWith(
        "Index papers",
        "Index the project literature.",
      ),
    );
    expect(workTaskCreate).not.toHaveBeenCalled();

    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Save to to-do only" }));
    await waitFor(() =>
      expect(workTaskCreate).toHaveBeenCalledWith(
        "Index papers",
        "Index the project literature.",
      ),
    );
  });

  /**
   * The failure this whole state exists for: a work-task turn may call
   * `AskUserQuestion`, and before the board could show it the run simply hung
   * at "running" with nothing able to answer.
   */
  it("shows a parked question and answers it from the card", async () => {
    const asking = task({
      id: "task-question",
      title: "Rewrite section 3",
      status: "awaiting_input",
      progressMessage: "Waiting for your answer",
      pendingAction: {
        kind: "question",
        toolUseId: "toolu_1",
        header: "Scope",
        question: "Rewrite section 3 only, or the whole chapter?",
        options: ["Section 3", "Whole chapter"],
        askedAt: Date.now(),
      },
    });
    workTaskSnapshot.mockResolvedValue(snapshot([asking]));
    workTaskReply.mockResolvedValue(asking);

    render(<Tasks />);

    expect(
      await screen.findByText("Rewrite section 3 only, or the whole chapter?"),
    ).toBeTruthy();
    // It sits under "Needs you", not under in-progress work.
    expect(screen.getByText("Waiting for you")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Whole chapter" }));
    await waitFor(() =>
      expect(workTaskReply).toHaveBeenCalledWith("task-question", "Whole chapter"),
    );

    // And a free-text answer goes through the same command.
    fireEvent.change(screen.getByLabelText(/Pick one/), {
      target: { value: "Just the opening paragraph" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() =>
      expect(workTaskReply).toHaveBeenCalledWith(
        "task-question",
        "Just the opening paragraph",
      ),
    );
  });

  /** Resume, not Start: the card keeps its checkout, and the two buttons do
   *  opposite things to the work already in it. */
  it("offers resume rather than start on a paused card", async () => {
    workTaskSnapshot.mockResolvedValue(
      snapshot([
        task({
          id: "task-paused",
          title: "Long job",
          status: "paused",
          stopReason: "pause",
        }),
      ]),
    );
    workTaskResume.mockResolvedValue(task({ id: "task-paused", status: "queued" }));

    render(<Tasks />);

    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    await waitFor(() => expect(workTaskResume).toHaveBeenCalledWith("task-paused"));
  });

  /**
   * A stale heartbeat must not animate as if work were happening. The dot is
   * the board's only claim that a process exists behind the row.
   */
  it("marks a run with no recent heartbeat as stale", async () => {
    workTaskSnapshot.mockResolvedValue(
      snapshot([
        task({
          id: "task-stale",
          status: "running",
          progressMessage: "Running the model turn",
          lastHeartbeatAt: Date.now() - 10 * 60_000,
        }),
      ]),
    );

    const { container } = render(<Tasks />);

    await screen.findByText("Running the model turn");
    expect(screen.getByText("no sign of activity for a while")).toBeTruthy();
    expect(container.querySelector(".tasks-pulse-live")).toBeNull();
    expect(container.querySelector(".tasks-pulse-stale")).toBeTruthy();
  });
});
