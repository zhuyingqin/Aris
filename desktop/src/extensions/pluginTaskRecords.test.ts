import { describe, expect, it } from "vitest";
import { ALL_WORK_TASK_STATUSES, STATUSES_BY_COLUMN } from "../tasks/boardColumns";
import { PLUGIN_TASK_STATE, pluginTaskRecord } from "./pluginTaskRecords";
import type { WorkTask } from "../types";

describe("plugin task states", () => {
  it("classify every board status consistently with the board's own columns", () => {
    // A status added to the board without a page state is a failure here, not a row stuck as "active".
    expect(Object.keys(PLUGIN_TASK_STATE).sort()).toEqual([...ALL_WORK_TASK_STATUSES].sort());
    for (const status of STATUSES_BY_COLUMN.inProgress) expect(PLUGIN_TASK_STATE[status]).toBe("active");
    for (const status of STATUSES_BY_COLUMN.done) expect(["done", "canceled"]).toContain(PLUGIN_TASK_STATE[status]);
    // What needs the user on the board needs the user (or is over) on a page too.
    for (const status of STATUSES_BY_COLUMN.attention) expect(["waiting", "ready", "failed"]).toContain(PLUGIN_TASK_STATE[status]);
  });

  it("summarises the rubric record the way the board does", () => {
    const task = {
      id: "t", title: "T", prompt: "", status: "review", sortOrder: 0, runSeq: 1, createdAt: 1, updatedAt: 2,
      reviewState: {
        round: 1, maxRounds: 2, verdict: "revise", summary: "s", issues: [], reviewerModel: "m", exhausted: false, checkedAt: 3,
        rubrics: {
          delivered: ["@lab/r/e"], omitted: ["@lab/r/big"], verdictCorrected: true,
          checks: [
            { criterion: "@lab/r/e#a", severity: "critical", result: "violated" },
            { criterion: "@lab/r/e#b", severity: "low", result: "unreported" },
            { criterion: "@lab/r/e#c", severity: "low", result: "met" },
          ],
        },
      },
    } as unknown as WorkTask;
    expect(pluginTaskRecord(task).review?.rubrics).toEqual({ sent: 3, violated: 1, unreported: 1, omitted: ["@lab/r/big"], corrected: true });
  });
});
