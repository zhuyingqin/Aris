// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  getRunningBatchJob,
  notifyBatchJobListeners,
  resetBatchJobRegistryForTests,
  setRunningBatchJob,
  useRunningBatchJob,
  type BatchJobHandle,
} from "../batchJobRegistry";

afterEach(() => {
  cleanup();
  resetBatchJobRegistryForTests();
});

function job(overrides: Partial<BatchJobHandle> = {}): BatchJobHandle {
  return {
    jobId: "wf-grading-1",
    activeRequestId: null,
    cancelled: false,
    progress: { kind: "grading", done: 3, total: 8 },
    ...overrides,
  };
}

/** Stands in for the Workflows tab, which the App mounts conditionally. */
function JobView({ runId }: { runId: string }) {
  const handle = useRunningBatchJob(runId);
  if (!handle) return <p>no job</p>;
  return (
    <p>
      {handle.jobId} {handle.progress.done}/{handle.progress.total}
      {handle.cancelled ? " cancelled" : ""}
    </p>
  );
}

describe("batchJobRegistry", () => {
  it("keeps a running job reachable across an unmount and remount", () => {
    // The App renders Workflows as `{tab === "workflows" && <Workflows />}`, so
    // leaving the tab unmounts it while the batch loop keeps running and writing
    // checkpoints. A per-mount ref came back empty here, which left the live job
    // with no reachable Stop and let a second one start over it.
    const view = render(<JobView runId="review-1" />);
    act(() => setRunningBatchJob("review-1", job()));
    expect(screen.getByText(/wf-grading-1 3\/8/)).toBeTruthy();

    view.unmount();
    expect(getRunningBatchJob("review-1")).not.toBeNull();

    render(<JobView runId="review-1" />);
    expect(screen.getByText(/wf-grading-1 3\/8/)).toBeTruthy();
  });

  it("returns the handle by identity so Stop can reach the loop's own flag", () => {
    const live = job();
    act(() => setRunningBatchJob("review-1", live));
    render(<JobView runId="review-1" />);

    // The loop watches this exact object; copying it would make Stop a no-op.
    expect(getRunningBatchJob("review-1")).toBe(live);
    live.cancelled = true;
    act(() => notifyBatchJobListeners());
    expect(screen.getByText(/cancelled/)).toBeTruthy();
  });

  it("scopes jobs to their own run", () => {
    setRunningBatchJob("review-1", job());
    render(<JobView runId="review-2" />);
    expect(screen.getByText("no job")).toBeTruthy();
    expect(getRunningBatchJob("review-2")).toBeNull();
  });

  it("clears a finished job and tells mounted views", () => {
    setRunningBatchJob("review-1", job());
    render(<JobView runId="review-1" />);
    expect(screen.getByText(/wf-grading-1/)).toBeTruthy();

    act(() => setRunningBatchJob("review-1", null));
    expect(screen.getByText("no job")).toBeTruthy();
  });
});
