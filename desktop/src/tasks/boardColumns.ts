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
  inProgress: ["preparing", "running", "pausing", "reviewing", "revising", "merging"],
  attention: ["paused", "awaiting_input", "review", "interrupted", "failed"],
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
    // A pause was asked for but the turn has not wound down. Still working,
    // and still holding its slot — calling it stopped would be a lie the user
    // could act on.
    case "pausing":
    // The independent Reviewer is checking the committed result, or the
    // executor is acting on what it found. Both are the engine working; the
    // user is not involved until a verdict exists.
    case "reviewing":
    case "revising":
    // A conflict-resolution Agent is actively working in the isolated
    // checkout. Keep it with other in-flight work rather than under "Needs
    // you"; only an exhausted/blocked repair returns to Review.
    case "merging":
      return "inProgress";
    // Everything here is stopped and waiting on a person: to answer, to
    // resume, or to accept.
    case "paused":
    case "awaiting_input":
    case "review":
    case "interrupted":
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

/**
 * Whether the board should offer to start this card from scratch.
 *
 * Kept apart from {@link canResume} because the two do different things to the
 * user's work: a start cuts a fresh checkout, a resume continues the one that
 * is already there. A single button for both would silently destroy a paused
 * task's half-finished edits.
 */
export function canStart(task: WorkTask): boolean {
  return task.status === "todo" || task.status === "canceled";
}

/** Whether the card can be continued in the checkout and session it has. */
export function canResume(task: WorkTask): boolean {
  return (
    task.status === "paused" ||
    task.status === "interrupted" ||
    task.status === "failed"
  );
}

/**
 * Whether pausing is offerable.
 *
 * Deliberately excludes `queued`: nothing is running, so there is nothing to
 * wind down, and the honest action there is Stop.
 */
export function canPause(task: WorkTask): boolean {
  return (
    task.status === "preparing" ||
    task.status === "running" ||
    // The review loop can run for several model calls. Making it the one
    // stretch of a task the user cannot interrupt would be arbitrary.
    task.status === "reviewing" ||
    task.status === "revising"
  );
}

/** The question a card is parked on, if any. */
export function pendingQuestion(task: WorkTask) {
  if (task.status !== "awaiting_input") return null;
  const action = task.pendingAction;
  return action?.kind === "question" ? action : null;
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
    task.status === "running" ||
    task.status === "pausing" ||
    task.status === "awaiting_input" ||
    task.status === "reviewing" ||
    task.status === "revising"
  );
}

/**
 * Editing and deleting are refused while the engine owns the card.
 *
 * Mirrors `WorkTaskStatus::is_engine_owned` in Rust, which is what actually
 * refuses the write; this copy only decides whether to offer the button.
 * `paused` and `interrupted` are NOT owned — no turn is executing, so the card
 * is the user's to edit, resume, or throw away.
 */
export function isEngineOwned(task: WorkTask): boolean {
  return (
    task.status === "queued" ||
    task.status === "preparing" ||
    task.status === "running" ||
    task.status === "pausing" ||
    task.status === "awaiting_input" ||
    task.status === "reviewing" ||
    task.status === "revising" ||
    task.status === "merging"
  );
}

/**
 * How long a card may go without a heartbeat before the board stops presenting
 * it as actively working.
 *
 * Well above the engine's 5s cadence: a single missed write (a slow disk, a
 * busy tick) must not make a healthy run look dead. What this catches is the
 * other failure — a row that says `running` with no process behind it at all.
 */
export const HEARTBEAT_STALE_MS = 45_000;

/** Whether the card has recent proof that something is actually running. */
export function heartbeatIsFresh(task: WorkTask, now = Date.now()): boolean {
  const beat = task.lastHeartbeatAt;
  return typeof beat === "number" && now - beat < HEARTBEAT_STALE_MS;
}
