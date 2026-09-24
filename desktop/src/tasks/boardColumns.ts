import type { WorkTask, WorkTaskStatus } from "../types";

/**
 * The four board columns. Backend statuses are exact; the board aggregates
 * them, so a user reads "needs attention" rather than distinguishing `review`
 * from `failed` at a glance.
 */
export type BoardColumnId = "todo" | "inProgress" | "attention" | "done";

export const BOARD_COLUMN_IDS: BoardColumnId[] = [
  "todo",
  "inProgress",
  "attention",
  "done",
];

/**
 * The exact statuses behind each column, written out as a table.
 * `columnForStatus` stays the single source of truth for the mapping; this is
 * its spec copy, and `boardColumns.test.ts` asserts the two agree and that
 * every `WorkTaskStatus` appears here exactly once — which is what makes
 * adding a status without filing it in a column a test failure rather than a
 * card that silently vanishes from the board.
 */
export const STATUSES_BY_COLUMN: Record<BoardColumnId, WorkTaskStatus[]> = {
  todo: ["todo", "queued"],
  inProgress: ["preparing", "running"],
  attention: ["review", "merging", "failed"],
  done: ["done", "canceled"],
};

/** Every status, in column order — the flattened spec table above. */
export const ALL_WORK_TASK_STATUSES: WorkTaskStatus[] =
  BOARD_COLUMN_IDS.flatMap((column) => STATUSES_BY_COLUMN[column]);

export function columnForStatus(status: WorkTaskStatus): BoardColumnId {
  switch (status) {
    case "todo":
    // Claimed but still waiting for a slot — nothing is happening yet, so it
    // reads as "not started" rather than as progress.
    case "queued":
      return "todo";
    // Out of the queue and working (worktree, then the model turn), just
    // without a diff to show yet.
    case "preparing":
    case "running":
      return "inProgress";
    case "review":
    // A merge is work, but the card must not bounce across the board when the
    // user clicks accept — it stays put and moves straight to Done.
    case "merging":
    case "failed":
      return "attention";
    case "done":
    case "canceled":
      return "done";
  }
}

/**
 * Bucket tasks into the four columns. Canceled cards are hidden unless asked
 * for — they are the one status a user routinely does not want to look at, and
 * they cannot be filtered by column because they share Done.
 *
 * Every column reads freshest-first, so whatever just moved sits at the top.
 * The sort is stable and the backend hands rows over in board order
 * (`sortOrder`, then id), so equal timestamps keep that order — which is what
 * preserves a drag: a reorder stamps the dragged cards with one `updatedAt`,
 * they tie, and the fallback is the order just written.
 */
export function groupTasksByColumn(
  tasks: WorkTask[],
  showCanceled: boolean,
): Record<BoardColumnId, WorkTask[]> {
  const grouped: Record<BoardColumnId, WorkTask[]> = {
    todo: [],
    inProgress: [],
    attention: [],
    done: [],
  };
  for (const task of tasks) {
    if (task.status === "canceled" && !showCanceled) continue;
    grouped[columnForStatus(task.status)].push(task);
  }
  for (const column of BOARD_COLUMN_IDS) {
    grouped[column].sort(byFreshest);
  }
  return grouped;
}

function byFreshest(left: WorkTask, right: WorkTask): number {
  return right.updatedAt - left.updatedAt;
}

/** Whether the board should offer to start this card. */
export function canStart(task: WorkTask): boolean {
  return task.status === "todo" || task.status === "failed" || task.status === "canceled";
}

/**
 * Whether accepting is offerable.
 *
 * Keyed on the worktree being present, NOT on `lastError`. A reviewed task
 * whose checkout vanished cannot be merged and the button would only produce an
 * error the user cannot act on — but a task whose *last merge attempt* failed
 * (the project was on another branch, say) carries a `lastError` too, and there
 * the user fixes the cause and tries again. Conflating them hid Accept forever
 * after one failed merge.
 */
export function canAccept(task: WorkTask): boolean {
  return task.status === "review" && !task.worktreeMissing;
}

/** A merge writes the base branch, so it is the one thing not interruptible. */
export function canCancel(task: WorkTask): boolean {
  return (
    task.status === "queued" ||
    task.status === "preparing" ||
    task.status === "running"
  );
}

/** Editing and deleting are refused while the engine owns the card. */
export function isEngineOwned(task: WorkTask): boolean {
  return (
    task.status === "queued" ||
    task.status === "preparing" ||
    task.status === "running" ||
    task.status === "merging"
  );
}
