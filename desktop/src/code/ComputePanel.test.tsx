// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComputeJobRecord,
  ComputeNodeCapabilities,
  ComputePeer,
} from "../types";

const mocks = vi.hoisted(() => ({
  computeCancel: vi.fn(),
  computeCapabilities: vi.fn(),
  computeEventsAfter: vi.fn(),
  computeJobsList: vi.fn(),
  computePeersList: vi.fn(),
  computeReadLog: vi.fn(),
  computeSubmit: vi.fn(),
  onComputeJobEvent: vi.fn(),
  onComputePeerEvent: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  computeCancel: mocks.computeCancel,
  computeCapabilities: mocks.computeCapabilities,
  computeEventsAfter: mocks.computeEventsAfter,
  computeJobsList: mocks.computeJobsList,
  computePeersList: mocks.computePeersList,
  computeReadLog: mocks.computeReadLog,
  computeSubmit: mocks.computeSubmit,
  onComputeJobEvent: mocks.onComputeJobEvent,
  onComputePeerEvent: mocks.onComputePeerEvent,
}));

import ComputePanel from "./ComputePanel";

const capabilities: ComputeNodeCapabilities = {
  nodeId: "local-node",
  displayName: "Workstation A",
  platform: "windows",
  architecture: "x86_64",
  logicalCpus: 16,
  supportsCommand: true,
  supportsPython: true,
  supportsNotebook: true,
  maxParallelJobs: 2,
  workerVersion: "0.4.34",
};

const remotePeer: ComputePeer = {
  endpointId: "endpoint-remote",
  nodeId: "remote-node",
  displayName: "Workstation B",
  gatewayUrl: "wss://relay.example.test",
  connected: true,
  transport: "p2p_tcp",
  pairedAtUnixMs: 1,
  lastSeenAtUnixMs: 2,
  direction: "invited",
  agentChatAuthorized: true,
};

function jobRecord(status: ComputeJobRecord["status"]): ComputeJobRecord {
  return {
    protocolVersion: 1,
    request: {
      protocolVersion: 1,
      jobId: "job-12345678",
      projectId: "project-a",
      displayName: "Python · run.py",
      workload: { kind: "python", entrypoint: "scripts/run.py", args: [], interpreter: null },
      workingDirectory: ".",
      environment: {},
      artifactGlobs: ["outputs/**"],
      limits: { timeoutSecs: 300 },
    },
    target: { kind: "remote", node_id: remotePeer.nodeId, node_name: remotePeer.displayName },
    status,
    createdAtUnixMs: 1_000,
    updatedAtUnixMs: 2_000,
    startedAtUnixMs: status === "queued" ? null : 1_500,
    finishedAtUnixMs: status === "succeeded" ? 2_000 : null,
    lastSequence: 2,
    result: status === "succeeded"
      ? {
          jobId: "job-12345678",
          status: "succeeded",
          exitCode: 0,
          startedAtUnixMs: 1_500,
          finishedAtUnixMs: 2_000,
          durationMs: 500,
          stdoutBytes: 5,
          stderrBytes: 0,
          artifacts: [{
            path: "outputs/result.csv",
            sizeBytes: 2048,
            sha256: "abc123",
            mediaType: "text/csv",
          }],
          metrics: {},
          workerDeviceId: remotePeer.nodeId,
          workerName: remotePeer.displayName,
        }
      : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.computeCapabilities.mockResolvedValue(capabilities);
  mocks.computePeersList.mockResolvedValue([remotePeer]);
  mocks.computeJobsList.mockResolvedValue([]);
  mocks.computeReadLog.mockResolvedValue({ text: "", nextOffset: 0, eof: true });
  mocks.computeEventsAfter.mockResolvedValue([]);
  mocks.computeCancel.mockResolvedValue(undefined);
  mocks.onComputeJobEvent.mockResolvedValue(() => undefined);
  mocks.onComputePeerEvent.mockResolvedValue(() => undefined);
});

afterEach(() => cleanup());

describe("ComputePanel", () => {
  it("submits the active Python file to the selected online computer", async () => {
    mocks.computeSubmit.mockResolvedValue(jobRecord("queued"));
    render(
      <ComputePanel
        language="en"
        projectId="project-a"
        projectPath="F:/ProjectA"
        activePath="F:/ProjectA/scripts/run.py"
        activeKind="file"
      />,
    );

    const target = await screen.findByRole("combobox");
    fireEvent.change(target, { target: { value: remotePeer.nodeId } });
    fireEvent.click(screen.getByRole("button", { name: "Run current file on target" }));

    await waitFor(() => expect(mocks.computeSubmit).toHaveBeenCalledWith(expect.objectContaining({
      targetNodeId: remotePeer.nodeId,
      workload: {
        kind: "python",
        entrypoint: "scripts/run.py",
        args: [],
        interpreter: null,
      },
    })));
    expect(await screen.findByText("Python · run.py")).toBeTruthy();
  });

  it("loads durable logs and cancels a running remote job", async () => {
    mocks.computeJobsList.mockResolvedValue([jobRecord("running")]);
    mocks.computeReadLog
      .mockResolvedValueOnce({ text: "hello\n", nextOffset: 6, eof: true })
      .mockResolvedValueOnce({ text: "warning\n", nextOffset: 8, eof: true });
    render(
      <ComputePanel
        language="en"
        projectId="project-a"
        projectPath="F:/ProjectA"
        activePath={null}
        activeKind={null}
      />,
    );

    expect(await screen.findByText("hello", { exact: false })).toBeTruthy();
    expect(screen.getByText("warning", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(mocks.computeCancel).toHaveBeenCalledWith("job-12345678"));
  });

  it("shows the verified artifact manifest of a completed job", async () => {
    mocks.computeJobsList.mockResolvedValue([jobRecord("succeeded")]);
    render(
      <ComputePanel
        language="en"
        projectId="project-a"
        projectPath="F:/ProjectA"
        activePath={null}
        activeKind={null}
      />,
    );

    expect(await screen.findByText("Artifacts")).toBeTruthy();
    expect(screen.getByText("outputs/result.csv", { exact: false })).toBeTruthy();
  });
});
