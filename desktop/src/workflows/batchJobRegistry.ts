import { useEffect, useReducer } from "react";

import type { WorkflowBatchJobKind } from "./workflowTypes";

export interface BatchJobProgress {
  kind: WorkflowBatchJobKind;
  done: number;
  total: number;
}

/** Live handle on a running batched job, shared between the loop and Stop. */
export interface BatchJobHandle {
  jobId: string;
  /** Request id of the batch currently in flight, for backend cancellation. */
  activeRequestId: string | null;
  cancelled: boolean;
  progress: BatchJobProgress;
}

/**
 * Running batched jobs, keyed by run id.
 *
 * Module scope rather than a `useRef` inside `Workflows`, because the App
 * renders that component as `{tab === "workflows" && <Workflows />}` — switching
 * to any other tab unmounts it while the job's async loop keeps running and
 * writing checkpoints. A per-mount ref came back `null` on remount, which left
 * the live job with no reachable Stop and let a second one be started over it.
 */
const runningBatchJobs = new Map<string, BatchJobHandle>();

const listeners = new Set<() => void>();

export function getRunningBatchJob(runId: string | undefined): BatchJobHandle | null {
  return runId ? runningBatchJobs.get(runId) ?? null : null;
}

/**
 * Re-renders subscribed views without replacing the handle.
 *
 * Stop mutates `cancelled` on the instance the loop is watching, so the change
 * is invisible to React by design; this is how the button still updates.
 */
export function notifyBatchJobListeners() {
  for (const listener of listeners) listener();
}

export function setRunningBatchJob(runId: string, job: BatchJobHandle | null) {
  if (job) runningBatchJobs.set(runId, job);
  else runningBatchJobs.delete(runId);
  notifyBatchJobListeners();
}

/**
 * Subscribes a mounted view to the registry.
 *
 * Returns the handle by identity rather than a copy, so callers can mutate the
 * object the running loop is holding.
 */
export function useRunningBatchJob(runId: string | undefined): BatchJobHandle | null {
  const [, bump] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  return getRunningBatchJob(runId);
}

/** Test seam: drops every registered job. Never called by the app. */
export function resetBatchJobRegistryForTests() {
  runningBatchJobs.clear();
  listeners.clear();
}
