import { describe, expect, it } from "vitest";

import type { WorkTask, WorkTaskStatus } from "../types";
import {
  ALL_WORK_TASK_STATUSES,
  BOARD_COLUMN_IDS,
  canAccept,
  canCancel,
  canStart,
  columnForStatus,
  groupTasksByColumn,
  isEngineOwned,
  STATUSES_BY_COLUMN,
} from "./boardColumns";

/** The backend's vocabulary, mirrored from `work_task_statuses_are_exhaustive`. */
const BACKEND_STATUSES: WorkTaskStatus[] = [
  "todo",
  "queued",
  "preparing",
  "running",
  "review",
  "merging",
  "done",
  "failed",
  "canceled",
];

function task(overrides: Partial<WorkTask> & { id: string }): WorkTask {
  return {
    title: overrides.id,
    prompt: "",
    status: "todo",
    sortOrder: 0,
    runSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("board columns", () => {
  /** A status the board cannot file into a column disappears from the UI
   *  entirely. That has to be a test failure, not a silent gap. */
  it("files every backend status into exactly one column", () => {
    expect([...ALL_WORK_TASK_STATUSES].sort()).toEqual([...BACKEND_STATUSES].sort());
    const seen = new Map<WorkTaskStatus, number>();
    for (const column of BOARD_COLUMN_IDS) {
      for (const status of STATUSES_BY_COLUMN[column]) {
        seen.set(status, (seen.get(status) ?? 0) + 1);
      }
    }
    for (const status of BACKEND_STATUSES) {
      expect(seen.get(status), `${status} is not in exactly one column`).toBe(1);
    }
  });

  /** The spec table and the function have to agree, or the table stops being
   *  documentation and starts being a lie. */
  it("keeps the spec table and columnForStatus in agreement", () => {
    for (const column of BOARD_COLUMN_IDS) {
      for (const status of STATUSES_BY_COLUMN[column]) {
        expect(columnForStatus(status)).toBe(column);
      }
    }
  });

  /** A merge conflict is now an Agent-owned pass, so it belongs with active
   *  work. Only a repair that exhausts its attempts comes back to attention. */
  it("shows an Agent-assisted merge as active work", () => {
    expect(columnForStatus("merging")).toBe("inProgress");
    expect(columnForStatus("review")).toBe("attention");
  });

  /** Queued is waiting, not working: showing it as in-progress would suggest
   *  something is happening when the task has not been claimed yet. */
  it("shows a queued card as not started", () => {
    expect(columnForStatus("queued")).toBe("todo");
    expect(columnForStatus("preparing")).toBe("inProgress");
  });

  it("hides canceled cards unless asked for", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", status: "canceled" }),
    ];
    expect(groupTasksByColumn(tasks, false).done.map((item) => item.id)).toEqual(["a"]);
    expect(groupTasksByColumn(tasks, true).done.map((item) => item.id).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("reads each column freshest-first", () => {
    const grouped = groupTasksByColumn(
      [
        task({ id: "old", status: "todo", updatedAt: 100 }),
        task({ id: "new", status: "todo", updatedAt: 300 }),
        task({ id: "mid", status: "todo", updatedAt: 200 }),
      ],
      false,
    );
    expect(grouped.todo.map((item) => item.id)).toEqual(["new", "mid", "old"]);
  });

  /** Equal timestamps must keep the backend's board order, which is what
   *  preserves a drag: a reorder stamps the moved cards with one `updatedAt`. */
  it("preserves backend order when timestamps tie", () => {
    const grouped = groupTasksByColumn(
      [
        task({ id: "first", status: "todo", updatedAt: 5 }),
        task({ id: "second", status: "todo", updatedAt: 5 }),
        task({ id: "third", status: "todo", updatedAt: 5 }),
      ],
      false,
    );
    expect(grouped.todo.map((item) => item.id)).toEqual(["first", "second", "third"]);
  });
});

describe("card affordances", () => {
  it("offers start only where a run can begin", () => {
    for (const status of ["todo", "failed", "canceled"] as WorkTaskStatus[]) {
      expect(canStart(task({ id: "t", status })), status).toBe(true);
    }
    for (const status of [
      "queued",
      "preparing",
      "running",
      "review",
      "merging",
      "done",
    ] as WorkTaskStatus[]) {
      expect(canStart(task({ id: "t", status })), status).toBe(false);
    }
  });

  /** A merge writes the base branch, so it is the one thing the user cannot
   *  interrupt — the button must not be offered at all. */
  it("never offers stop during a merge", () => {
    expect(canCancel(task({ id: "t", status: "merging" }))).toBe(false);
    expect(canCancel(task({ id: "t", status: "running" }))).toBe(true);
  });

  /** A reviewed task whose worktree vanished cannot be merged. Offering the
   *  button would produce an error the user has no way to act on. */
  it("withholds accept from a reviewed task whose work is gone", () => {
    expect(canAccept(task({ id: "t", status: "review" }))).toBe(true);
    expect(
      canAccept(task({ id: "t", status: "review", worktreeMissing: true })),
    ).toBe(false);
  });

  /** The regression that motivated splitting the two fields: a merge refused
   *  because the project was on another branch is fixable, and the user must
   *  still be able to retry it. */
  it("keeps accept offered after a merge attempt that merely failed", () => {
    expect(
      canAccept(
        task({
          id: "t",
          status: "review",
          lastError: "this task was cut from 'main' but the project is on 'other'",
        }),
      ),
    ).toBe(true);
  });

  /** Edit and delete are hidden exactly while the engine owns the card; the
   *  backend refuses them there, and a button that always errors is worse than
   *  no button. */
  it("hides edit and delete for exactly the engine-owned statuses", () => {
    for (const status of ["queued", "preparing", "running", "merging"] as WorkTaskStatus[]) {
      expect(isEngineOwned(task({ id: "t", status })), status).toBe(true);
    }
    for (const status of ["todo", "review", "done", "failed", "canceled"] as WorkTaskStatus[]) {
      expect(isEngineOwned(task({ id: "t", status })), status).toBe(false);
    }
  });
});
