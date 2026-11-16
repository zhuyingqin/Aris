// What a plugin page sees of the tasks it proposed. Built by the host from the
// board's own records, never from what the task's model chose to write back,
// so a page can tell finished from failed from stuck without trusting the task.
import type { WorkTask, WorkTaskStatus } from "../types";

/** Where a task stands, in the terms a page needs to draw a row. */
export type PluginTaskState =
  /** On the board, not started: created without starting it. */
  | "todo"
  /** Queued, running, under review, being revised or merged. */
  | "active"
  /** Paused, interrupted, or asking the user a question: it needs someone. */
  | "waiting"
  /** Finished and waiting for the user to accept it on the board. */
  | "ready"
  /** Accepted, or finished with nothing to merge. */
  | "done"
  | "failed"
  | "canceled";

export interface PluginTaskRecord {
  taskId: string;
  title: string;
  /** The board's own status, for a page that wants the detail. */
  status: WorkTaskStatus;
  state: PluginTaskState;
  /** What it is doing right now, while active. */
  phase?: string;
  updatedAt: number;
  /** The widget the task was asked to write its conclusion to. */
  reportTo?: string;
  /** What the independent Reviewer concluded, as the board recorded it. */
  review?: {
    verdict: string;
    summary: string;
    round: number;
    exhausted: boolean;
    issues: { severity: string; title: string; criterion?: string }[];
    rubrics?: { sent: number; violated: number; unreported: number; omitted: string[]; corrected: boolean };
  };
  /** The evidence the run left: its closing summary, the files it changed and what it produced. */
  result?: {
    summary: string;
    filesChanged: number;
    files: string[];
    artifacts: string[];
    merged: boolean;
  };
  error?: string;
}

const MAX_SUMMARY_CHARS = 4000;
const MAX_FILES = 50;
const MAX_ISSUES = 12;

const STATE: Record<WorkTaskStatus, PluginTaskState> = {
  todo: "todo",
  queued: "active",
  preparing: "active",
  running: "active",
  pausing: "active",
  paused: "waiting",
  awaiting_input: "waiting",
  reviewing: "active",
  revising: "active",
  review: "ready",
  merging: "active",
  interrupted: "waiting",
  done: "done",
  failed: "failed",
  canceled: "canceled",
};

export function pluginTaskRecord(task: WorkTask): PluginTaskRecord {
  const state = STATE[task.status] ?? "active";
  const record: PluginTaskRecord = {
    taskId: task.id,
    title: task.title,
    status: task.status,
    state,
    updatedAt: task.updatedAt,
  };
  if (task.origin?.reportWidget) record.reportTo = task.origin.reportWidget;
  if (state === "active" && task.progressMessage) record.phase = task.progressMessage.slice(0, 300);
  const review = task.reviewState;
  if (review) {
    const checks = review.rubrics?.checks ?? [];
    record.review = {
      verdict: review.verdict,
      summary: review.summary.slice(0, 1000),
      round: review.round,
      exhausted: review.exhausted,
      issues: review.issues.slice(0, MAX_ISSUES).map((issue) => ({
        severity: issue.severity,
        title: issue.title,
        ...(issue.criterion ? { criterion: issue.criterion } : {}),
      })),
      ...(review.rubrics ? {
        rubrics: {
          sent: checks.length,
          violated: checks.filter((check) => check.result === "violated").length,
          unreported: checks.filter((check) => check.result === "unreported").length,
          omitted: review.rubrics.omitted ?? [],
          corrected: review.rubrics.verdictCorrected === true,
        },
      } : {}),
    };
  }
  if (task.resultSummary || task.changes || task.reviewSnapshot) {
    record.result = {
      summary: (task.resultSummary ?? "").slice(0, MAX_SUMMARY_CHARS),
      filesChanged: task.changes?.filesChanged ?? task.reviewSnapshot?.files.length ?? 0,
      files: (task.reviewSnapshot?.files ?? []).slice(0, MAX_FILES).map((file) => file.path),
      artifacts: (task.reviewSnapshot?.artifacts ?? []).map((artifact) => artifact.relativePath),
      merged: Boolean(task.mergeCommit),
    };
  }
  if ((state === "failed" || state === "waiting") && task.lastError) record.error = task.lastError.slice(0, 1000);
  return record;
}

/** The tasks a page proposed, newest first. */
export function pluginTaskRecords(tasks: WorkTask[], pluginName: string, panelId: string): PluginTaskRecord[] {
  return tasks
    .filter((task) => task.origin?.pluginName === pluginName && task.origin.panelId === panelId)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(pluginTaskRecord);
}
