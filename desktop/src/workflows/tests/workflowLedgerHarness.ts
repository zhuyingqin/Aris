import { vi } from "vitest";

import type { ReviewWorkflowRun, ReviewWorkflowSummary } from "../workflowTypes";

/**
 * An in-memory stand-in for the Rust review-workflow ledger.
 *
 * The orchestration layer is the part of this module that reads state, calls the
 * backend, computes a transition and writes it back — and it is the part every
 * defect found in this workflow has lived in. None of it runs under the existing
 * tests, because they execute in browser-preview mode where `isTauri()` is false
 * and all twenty-nine backend-touching handlers early-return.
 *
 * What makes this harness worth having rather than a pile of `vi.fn()` is that
 * it reproduces the two server-side rules the UI keeps getting wrong:
 *
 *   - **Optimistic concurrency.** A save states the revision it was built on and
 *     is rejected if the ledger has moved. Acquiring and releasing a lease each
 *     bump the revision too, so a batched job leaves the caller's copy several
 *     revisions behind — exactly the gap that produced
 *     `expected revision 170, current revision 173`.
 *   - **Model turns are validated the same way.** `review_workflow_*_turn`
 *     carries `expectedRevision` and fails on a mismatch, which is why a batch
 *     whose model call reuses the run captured at job start dies on its second
 *     batch.
 *
 * A mock that ignored either rule would let those bugs pass silently, which is
 * the situation this harness exists to end.
 */
export interface WorkflowLedger {
  runs: Map<string, ReviewWorkflowRun>;
  /** Every model turn the orchestration layer issued, in order. */
  turns: Array<{ actor: "executor" | "reviewer"; prompt: string; system: string; revision: number }>;
  /** Queued replies, consumed in order; the last one repeats once exhausted. */
  executorReplies: string[];
  reviewerReplies: string[];
  put(run: ReviewWorkflowRun): void;
  get(id: string): ReviewWorkflowRun;
}

function revisionConflict(expected: number, current: number) {
  // Worded like the Rust error so a test failure reads the way the app does.
  return new Error(
    `review workflow changed on disk (expected revision ${expected}, current revision ${current})`,
  );
}

function bump(run: ReviewWorkflowRun): ReviewWorkflowRun {
  return { ...run, revision: run.revision + 1, updatedAt: new Date().toISOString() };
}

export function createWorkflowLedger(): WorkflowLedger {
  const runs = new Map<string, ReviewWorkflowRun>();
  return {
    runs,
    turns: [],
    executorReplies: [],
    reviewerReplies: [],
    put(run) {
      runs.set(run.id, run);
    },
    get(id) {
      const run = runs.get(id);
      if (!run) throw new Error(`review workflow not found: ${id}`);
      return run;
    },
  };
}

function nextReply(queue: string[]) {
  if (queue.length === 0) return "{}";
  return queue.length === 1 ? queue[0] : queue.shift()!;
}

/**
 * Builds the `../../api/tauri` mock surface. Pass the result straight to
 * `vi.mock`, and drive the scenario by seeding `ledger.runs` and the reply
 * queues.
 */
export function createTauriMocks(ledger: WorkflowLedger) {
  const summary = (run: ReviewWorkflowRun): ReviewWorkflowSummary => ({
    id: run.id,
    title: run.title,
    topic: run.topic,
    status: run.status,
    activeStageId: run.activeStageId,
    revision: run.revision,
    updatedAt: run.updatedAt,
  });

  const requireRevision = (runId: string, expected: number | undefined) => {
    const current = ledger.get(runId);
    if (expected !== undefined && current.revision !== expected) {
      throw revisionConflict(expected, current.revision);
    }
    return current;
  };

  return {
    isTauri: vi.fn(() => true),

    reviewWorkflowsList: vi.fn(async () => [...ledger.runs.values()].map(summary)),
    reviewWorkflowLoad: vi.fn(async (id: string) => ledger.runs.get(id) ?? null),
    reviewWorkflowSave: vi.fn(async (input: {
      run: ReviewWorkflowRun;
      expectedRevision: number;
      actor: string;
      action: string;
      summary: string;
      stageId?: string;
    }) => {
      const current = requireRevision(input.run.id, input.expectedRevision);
      const now = new Date().toISOString();
      const saved: ReviewWorkflowRun = {
        ...input.run,
        revision: current.revision + 1,
        updatedAt: now,
        events: [
          ...input.run.events,
          {
            sequence: (input.run.events.at(-1)?.sequence ?? 0) + 1,
            timestamp: now,
            actor: input.actor,
            action: input.action,
            summary: input.summary,
            stageId: input.stageId,
          },
        ],
      };
      ledger.put(saved);
      return saved;
    }),
    reviewWorkflowCreate: vi.fn(async () => {
      throw new Error("createWorkflowRun is not part of this harness");
    }),
    reviewWorkflowRename: vi.fn(async () => {
      throw new Error("renameWorkflowRun is not part of this harness");
    }),
    reviewWorkflowDelete: vi.fn(async () => undefined),

    // A lease is a write: taking and giving it back each move the revision, so a
    // batched job ends several revisions ahead of the run its caller still holds.
    reviewWorkflowLeaseAcquire: vi.fn(async (runId: string) => {
      const leased = bump(ledger.get(runId));
      ledger.put(leased);
      return leased;
    }),
    reviewWorkflowLeaseRelease: vi.fn(async (runId: string) => {
      const released = bump(ledger.get(runId));
      ledger.put(released);
      return released;
    }),

    reviewWorkflowExecutorTurn: vi.fn(async (input: {
      runId: string;
      expectedRevision: number;
      system: string;
      prompt: string;
    }) => {
      const run = requireRevision(input.runId, input.expectedRevision);
      ledger.turns.push({
        actor: "executor",
        system: input.system,
        prompt: input.prompt,
        revision: run.revision,
      });
      return { text: nextReply(ledger.executorReplies), model: "test-model", sessionId: "wf" };
    }),
    reviewWorkflowReviewerTurn: vi.fn(async (input: {
      runId: string;
      expectedRevision: number;
      system: string;
      prompt: string;
    }) => {
      const run = requireRevision(input.runId, input.expectedRevision);
      ledger.turns.push({
        actor: "reviewer",
        system: input.system,
        prompt: input.prompt,
        revision: run.revision,
      });
      return nextReply(ledger.reviewerReplies);
    }),

    reviewWorkflowDriveOnce: vi.fn(async () => {
      throw new Error("the scope controller is not part of this harness");
    }),
    reviewWorkflowConfirmScopePlan: vi.fn(async () => {
      throw new Error("not part of this harness");
    }),
    reviewWorkflowSubmitScopePlan: vi.fn(async () => {
      throw new Error("not part of this harness");
    }),
    reviewWorkflowResetScopePlan: vi.fn(async () => {
      throw new Error("not part of this harness");
    }),

    literatureLoad: vi.fn(async () => ({
      papers: [] as unknown[],
      searchRuns: [] as unknown[],
      criteria: [] as unknown[],
    })),
    literatureApplyDelta: vi.fn(async (_delta: unknown) => undefined),
    literatureLlmCancel: vi.fn(async () => undefined),
    literatureSearchProtocolCreate: vi.fn(async (_draft: unknown) => ({ protocol: { id: "protocol-1" } })),
    literatureSearchProtocolPreview: vi.fn(async () => ({ plan: [] })),
    literatureSearchProtocolExecute: vi.fn(async () => ({
      searchRun: { id: "search-run-1", recordIds: [], sourceAttempts: [] },
    })),
    listenLiteratureSearchProgress: vi.fn(() => Promise.resolve(() => undefined)),
    listenReviewWorkflowTurnProgress: vi.fn(() => Promise.resolve(() => undefined)),

    chatCancel: vi.fn(async () => undefined),
    chatModelOptions: vi.fn(async () => ({ options: [], current: "test-model" })),
    openChatCompanion: vi.fn(async () => undefined),
  };
}
