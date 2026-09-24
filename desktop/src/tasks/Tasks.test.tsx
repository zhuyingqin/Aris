// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import type { WorkTask } from "../types";
import Tasks from "./Tasks";

const tasksStyles = readFileSync(resolve(process.cwd(), "src/tasks/Tasks.css"), "utf8");

const { workTaskList, workTaskCreate, workTaskDiff } = vi.hoisted(() => ({
  workTaskList: vi.fn<() => Promise<WorkTask[]>>(),
  workTaskCreate: vi.fn(),
  workTaskDiff: vi.fn(),
}));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    isTauri: () => true,
    workTaskList,
    workTaskCreate,
    workTaskUpdate: vi.fn(),
    workTaskDelete: vi.fn(),
    workTaskStart: vi.fn(),
    workTaskCancel: vi.fn(),
    workTaskReturnToTodo: vi.fn(),
    workTaskAccept: vi.fn(),
    workTaskDiff,
  };
});

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
  it("labels the review column as pending confirmation in Chinese", async () => {
    useStore.setState({ language: "cn" });
    workTaskList.mockResolvedValue([task({ id: "todo-task" })]);

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
    workTaskList.mockResolvedValue([review]);
    workTaskDiff.mockResolvedValue("diff --git a/survey.tex b/survey.tex");
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

    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    await waitFor(() => expect(workTaskDiff).toHaveBeenCalledWith(review.id));
    expect(await screen.findByText(/diff --git a\/survey\.tex/)).toBeTruthy();
    await waitFor(() => expect(workTaskList).toHaveBeenCalledTimes(2));
  });

  it("creates a task from the board editor", async () => {
    workTaskList.mockResolvedValue([]);
    workTaskCreate.mockResolvedValue(task({ id: "new-task", title: "Index papers" }));

    render(<Tasks />);
    await screen.findByText("No tasks yet");
    fireEvent.click(screen.getAllByRole("button", { name: /New task/ })[0]);
    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Index papers" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe the work/), {
      target: { value: "Index the project literature." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(workTaskCreate).toHaveBeenCalledWith(
      "Index papers",
      "Index the project literature.",
    ));
  });
});
