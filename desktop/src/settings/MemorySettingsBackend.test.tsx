// @vitest-environment jsdom
//
// The other MemorySettings suite exercises the browser preview data. This one
// runs the page against a mocked native backend, which is where the status bar
// has to be honest about what it does and does not know.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configSet,
  memoryExport,
  memoryStatus,
  memoryV2ConfirmR3,
  memoryV2HistoryPreview,
  memoryV2BuildProgress,
  memoryV2ImportHistory,
  memoryV2PendingR3,
  memoryV2RescreenRejected,
  memoryV2StartBuild,
  memoryV2Status,
  memoryV2Wake,
} from "../api/tauri";
import type { MemoryExplorerSnapshot, MemoryStatusView, MemoryV2StatusView } from "../types";
import { useStore } from "../store";
import MemorySettings from "./MemorySettings";

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  configSet: vi.fn(),
  memoryStatus: vi.fn(),
  memoryV2Status: vi.fn(),
  memoryV2PendingR3: vi.fn(),
  memoryV2ConfirmR3: vi.fn(),
  memoryV2HistoryPreview: vi.fn(),
  memoryV2ImportHistory: vi.fn(),
  memoryV2RescreenRejected: vi.fn(),
  memoryV2StartBuild: vi.fn(),
  memoryV2BuildProgress: vi.fn(),
  memoryV2Wake: vi.fn(),
  memoryExport: vi.fn(),
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
  l3: [],
  l0Total: 0,
  l1Total: 0,
  l2Total: 0,
  l3Total: 0,
  partialErrors: [],
});

const healthyStatus = (): MemoryStatusView => ({
  projectId: "project-a",
  componentVersion: "research_memory_v2",
  status: "healthy",
  dataPath: "/tmp/research-memory.sqlite3",
  outboxPending: 0,
  deadLetter: 1,
  l0Count: 7,
  l1Count: 3,
  l2Count: 1,
  l3Count: 1,
  captureExpected: 7,
  captureCovered: 7,
  captureMissing: 0,
  lastCapturedAt: "2026-08-10T12:00:00Z",
  lastCapturedSessionId: "chat-latest",
});

const healthyV2Status = (): MemoryV2StatusView => ({
  mode: "observe",
  legacyReadOnly: false,
  dataPath: "/tmp/research-memory-v2.sqlite3",
  remoteConfigured: false,
  stats: {
    pending_outbox: 2,
    deferred_outbox: 0,
    rejected_candidates: 1,
    r1_active: 3,
    r2_active: 1,
    r3_pending_confirmation: 1,
    r3_confirmed: 2,
  },
  model: "",
  availableModels: ["MiniMax-M3", "deepseek-v4-flash"],
});

async function importedMocks() {
  const api = await import("../api/tauri");
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

describe("MemorySettings against the native backend", () => {
  beforeEach(async () => {
    const api = await importedMocks();
    api.memoryExplorerSnapshot.mockResolvedValue(emptySnapshot());
    api.memoryGovernanceReadScenario.mockResolvedValue("");
    api.memoryV2Status.mockResolvedValue(healthyV2Status());
    api.memoryV2PendingR3.mockResolvedValue([]);
    api.memoryV2ConfirmR3.mockResolvedValue(true);
    api.memoryV2HistoryPreview.mockResolvedValue({
      sourceSessions: 0,
      finalTurns: 0,
      alreadyCaptured: 0,
      readyToQueue: 0,
    });
    api.memoryV2ImportHistory.mockResolvedValue({
      sourceSessions: 0,
      finalTurns: 0,
      queued: 0,
      alreadyCaptured: 0,
    });
    api.memoryV2Wake.mockResolvedValue(undefined);
    api.configSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useStore.setState({ currentProject: null });
  });

  it("shows placeholders rather than invented legacy counts until the status query answers", async () => {
    vi.mocked(memoryStatus).mockReturnValue(new Promise<MemoryStatusView>(() => {}));

    render(<MemorySettings language="en" />);

    expect(screen.getByText("loading")).toBeTruthy();
    // Every counter must read as unknown. A stand-in number here is
    // indistinguishable from a real library size.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText("2,429")).toBeNull();
  });

  it("keeps v2 visible when the memory status query fails", async () => {
    vi.mocked(memoryStatus).mockRejectedValue(new Error("memory database is locked"));

    render(<MemorySettings language="en" />);

    await screen.findByText(/memory database is locked/);
    expect(screen.getByText("Memory library: unavailable")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Observe/ }).getAttribute("aria-checked")).toBe("true");
    expect(Array.from(
      screen.getByLabelText("V2 memory status").querySelectorAll("strong"),
      (node) => node.textContent,
    )).toEqual(["2", "0", "3", "1", "1", "2"]);
  });

  it("clears a stale error once a later refresh succeeds", async () => {
    vi.mocked(memoryStatus).mockRejectedValueOnce(new Error("memory database is locked"));
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());

    render(<MemorySettings language="en" />);
    await screen.findByText(/memory database is locked/);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(screen.queryByText(/memory database is locked/)).toBeNull());
    expect(screen.getByText("R0 7 · V2 R1–R3 5")).toBeTruthy();
  });

  it("keeps the active v2 store below the familiar memory layout", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());

    render(<MemorySettings language="en" />);

    const library = await screen.findByText("Research memory library");
    const v2 = screen.getByText("Research memory v2 (active store)");
    expect(library.compareDocumentPosition(v2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows reviewed v2 atoms directly in the familiar library browser", async () => {
    const api = await importedMocks();
    api.memoryExplorerSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      l1Total: 1,
      l3Total: 1,
      l1: [{
        layer: "l1",
        id: "atom-current",
        content: "Final/main.pdf compiled successfully to 153 pages.",
        kind: "artifact_page_count",
        sessionId: "chat-final",
        status: "derived",
        subjectKey: "file:final/main.pdf",
        standingInjected: false,
        sourceEventIds: ["chat-final:1"],
      }],
      l3: [{
        layer: "l3",
        id: "research-constitution",
        content: "Stored profile projection",
        kind: "project_profile",
        lineage: [{
          atomId: "atom-current",
          statement: "Final/main.pdf compiled successfully to 153 pages.",
          kind: "artifact_page_count",
          status: "derived",
          subjectKey: "file:final/main.pdf",
          sourceSessionId: "chat-final",
          sourceEventIds: ["chat-final:1"],
          standingInjected: false,
        }],
      }],
    } satisfies MemoryExplorerSnapshot);
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());

    render(<MemorySettings language="en" />);

    fireEvent.click(await screen.findByRole("tab", { name: /R1/i }));
    expect(await screen.findByText("Current")).toBeTruthy();
    expect(screen.getByText("Recall only")).toBeTruthy();
    expect(screen.getByText("file:final/main.pdf")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /R3/i }));
    expect(await screen.findByText("Stored profile projection")).toBeTruthy();
  });

  it("opens on the first populated v2 layer when R1 is empty", async () => {
    const api = await importedMocks();
    api.memoryExplorerSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      l2Total: 1,
      l2: [{
        layer: "l2",
        id: "atom-r2",
        content: "The project focuses on robust forecasting.",
        kind: "project_research_focus",
        status: "active",
        version: "research_memory_v2",
        sessionId: "chat-history",
        sourceEventIds: ["chat-history:2"],
      }],
    } satisfies MemoryExplorerSnapshot);
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());

    render(<MemorySettings language="en" />);

    expect(await screen.findByText("The project focuses on robust forecasting.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /R2/i }).getAttribute("aria-selected")).toBe("true");
  });

  it("switches v2 rollout mode through the config and wakes the worker", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryV2Status)
      .mockResolvedValueOnce(healthyV2Status())
      .mockResolvedValueOnce({ ...healthyV2Status(), mode: "canary" });

    render(<MemorySettings language="en" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Canary/ }));

    await waitFor(() => expect(configSet).toHaveBeenCalledWith({ memoryV2Mode: "canary" }));
    expect(memoryV2Wake).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Canary/ }).getAttribute("aria-checked")).toBe("true"));
  });

  it("requires explicit confirmation before an R3 memory can be injected", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryV2PendingR3)
      .mockResolvedValueOnce([{
        id: "r3-preference",
        kind: "user_preference",
        statement: "Use Chinese for product settings.",
        status: "pending_confirmation",
        sourceEventIds: ["chat-a:2"],
        sourceQuote: "请使用中文设置界面",
      }])
      .mockResolvedValueOnce([]);

    render(<MemorySettings language="en" />);
    await screen.findByText("R3 awaiting your confirmation");
    fireEvent.click(screen.getByRole("button", { name: "Confirm for injection" }));

    await waitFor(() => expect(memoryV2ConfirmR3).toHaveBeenCalledWith("r3-preference"));
    await waitFor(() => expect(screen.queryByText("Use Chinese for product settings.")).toBeNull());
  });

  it("imports only previewed raw Session turns into the v2 queue", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryV2HistoryPreview).mockResolvedValue({
      sourceSessions: 3,
      finalTurns: 9,
      alreadyCaptured: 2,
      readyToQueue: 7,
    });
    vi.mocked(memoryV2ImportHistory).mockResolvedValue({
      sourceSessions: 3,
      finalTurns: 9,
      queued: 7,
      alreadyCaptured: 2,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<MemorySettings language="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Scan history" }));

    await screen.findByText("Found 3 Sessions and 9 final turns; 2 already captured, 7 ready to queue.");
    fireEvent.click(screen.getByRole("button", { name: "Queue for v2" }));

    await waitFor(() => expect(memoryV2ImportHistory).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    await screen.findByText("Queued 7 raw turns for v2 screening; 2 were already present.");
    confirm.mockRestore();
  });

  it("replays a corrected screening policy over turns already rejected", async () => {
    // A screening fix otherwise only reaches new conversations: captures the old
    // rules refused stay refused, so the layers they should have filled stay empty.
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryV2RescreenRejected).mockResolvedValue(49);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<MemorySettings language="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Re-screen rejected" }));

    await waitFor(() => expect(memoryV2RescreenRejected).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    await screen.findByText("Re-queued 49 previously rejected turns under the current rules.");
    confirm.mockRestore();
  });

  it("does not re-screen when the quota warning is declined", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<MemorySettings language="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Re-screen rejected" }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(memoryV2RescreenRejected).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("builds the derived layers with the chosen model and shows live progress", async () => {
    // A backlog is minutes of silent model calls. Without a running/processed
    // readout the user cannot tell a working pipeline from a stuck one.
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryV2StartBuild).mockResolvedValue({
      requeued: 49,
      pending: 88,
      model: "deepseek-v4-flash",
    });
    vi.mocked(memoryV2BuildProgress).mockResolvedValue({
      running: true,
      processed: 4,
      failed: 1,
      model: "deepseek-v4-flash",
      lastError: "memory extraction did not return valid JSON",
      lastStatement: "",
      startedAt: "2026-09-04T17:00:00Z",
      finishedAt: "",
    });

    render(<MemorySettings language="en" />);
    await screen.findByText("R0 7 · V2 R1–R3 5");

    fireEvent.change(screen.getByRole("combobox", { name: /Build model/i }), {
      target: { value: "deepseek-v4-flash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Backfill from history" }));

    await waitFor(() =>
      expect(memoryV2StartBuild).toHaveBeenCalledWith("deepseek-v4-flash"));
    await screen.findByText(/Building · model deepseek-v4-flash · 4 processed, 1 failed/);
    await screen.findByText(/memory extraction did not return valid JSON/);
  });

  it("falls back to the reviewer model when none is pinned", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryV2StartBuild).mockResolvedValue({
      requeued: 0,
      pending: 3,
      model: "configured reviewer",
    });
    vi.mocked(memoryV2BuildProgress).mockResolvedValue({
      running: false, processed: 0, failed: 0, model: "configured reviewer",
      lastError: "", lastStatement: "", startedAt: "", finishedAt: "",
    });

    render(<MemorySettings language="en" />);
    await screen.findByText("R0 7 · V2 R1–R3 5");
    fireEvent.click(screen.getByRole("button", { name: "Backfill from history" }));

    await waitFor(() => expect(memoryV2StartBuild).toHaveBeenCalledWith(undefined));
  });

  it("exposes the export command that had no entry point", async () => {
    vi.mocked(memoryStatus).mockResolvedValue(healthyStatus());
    vi.mocked(memoryExport).mockResolvedValue("/tmp/exports/research-memory.json");

    render(<MemorySettings language="en" />);
    await screen.findByText("R0 7 · V2 R1–R3 5");

    fireEvent.click(screen.getByRole("button", { name: "Export memory" }));

    await screen.findByText("Exported to /tmp/exports/research-memory.json");
  });
});
