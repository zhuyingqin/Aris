// @vitest-environment jsdom
//
// The other MemorySettings suite exercises the browser preview data. This one
// runs the page against a mocked native backend, which is where the status bar
// has to be honest about what it does and does not know.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  memoryDeadLetterRetry,
  memoryDeadLetters,
  memoryExport,
  memoryStatus,
} from "../api/tauri";
import type { MemoryExplorerSnapshot, MemoryStatusView } from "../types";
import { useStore } from "../store";
import MemorySettings from "./MemorySettings";

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  memoryStatus: vi.fn(),
  memoryDeadLetters: vi.fn(),
  memoryDeadLetterRetry: vi.fn(),
  memoryExport: vi.fn(),
  memoryMigrationPreview: vi.fn(),
  memoryMigrationExecute: vi.fn(),
  memoryMigrationProgress: vi.fn(),
  memoryMigrationCancel: vi.fn(),
  memoryExplorerSnapshot: vi.fn(),
  memoryGovernanceSearch: vi.fn(),
  memoryGovernanceReadScenario: vi.fn(),
  memoryGovernanceUpdate: vi.fn(),
  memoryGovernanceDelete: vi.fn(),
  memoryRecallPreview: vi.fn(),
}));

const emptySnapshot = (): MemoryExplorerSnapshot => ({
  projectId: "project-a",
  loadedAt: new Date().toISOString(),
  l0: [],
  l1: [],
  l2: [],
  l3: null,
  l0Total: 0,
  l1Total: 0,
  l2Total: 0,
  l3Total: 0,
  partialErrors: [],
});

const healthyStatus = (): MemoryStatusView => ({
  projectId: "project-a",
  componentVersion: "research-v1",
  status: "healthy",
  dataPath: "/tmp/research-memory.sqlite3",
  outboxPending: 0,
  deadLetter: 1,
  l0Count: 7,
  l1Count: 3,
  l2Count: 1,
  l3Count: 1,
});

async function importedMocks() {
  const api = await import("../api/tauri");
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

describe("MemorySettings against the native backend", () => {
  beforeEach(async () => {
    const api = await importedMocks();
    api.memoryExplorerSnapshot.mockResolvedValue(emptySnapshot());
    api.memoryDeadLetters.mockResolvedValue([]);
    api.memoryGovernanceReadScenario.mockResolvedValue("");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useStore.setState({ currentProject: null });
  });

  it("shows placeholders rather than numbers until the status query answers", async () => {
    vi.mocked(memoryStatus).mockReturnValue(new Promise<MemoryStatusView>(() => {}));

    render(<MemorySettings language="en" />);

    expect(screen.getByText("loading")).toBeTruthy();
    // Every counter must read as unknown. A stand-in number here is
    // indistinguishable from a real library size.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText("2,429")).toBeNull();
  });

  it("keeps the counters empty when the status query fails", async () => {
    vi.mocked(memoryStatus).mockRejectedValue(new Error("memory database is locked"));

    render(<MemorySettings language="en" />);

    await screen.findByText(/memory database is locked/);
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });

  it("clears a stale error once a later refresh succeeds", async () => {
    vi.mocked(memoryStatus).mockRejectedValueOnce(new Error("memory database is locked"));
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());

    render(<MemorySettings language="en" />);
    await screen.findByText(/memory database is locked/);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(screen.queryByText(/memory database is locked/)).toBeNull());
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("requeues dead letters instead of only listing them", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryDeadLetters).mockResolvedValueOnce([
      {
        id: "capture-1",
        sessionId: "chat-a",
        sourceEventIds: ["chat-a:4"],
        occurredAt: new Date().toISOString(),
        attempts: 10,
        lastError: "extraction failed",
        updatedAt: new Date().toISOString(),
      },
    ]);
    vi.mocked(memoryDeadLetterRetry).mockResolvedValue(1);

    render(<MemorySettings language="en" />);
    await screen.findByText(/Memory tasks needing attention/);

    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));

    await screen.findByText("Requeued 1 memory task");
    expect(memoryDeadLetterRetry).toHaveBeenCalledTimes(1);
  });

  it("exposes the export command that had no entry point", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryExport).mockResolvedValue("/tmp/exports/research-memory.json");

    render(<MemorySettings language="en" />);
    await screen.findByText("7");

    fireEvent.click(screen.getByRole("button", { name: "Export memory" }));

    await screen.findByText("Exported to /tmp/exports/research-memory.json");
  });
});
