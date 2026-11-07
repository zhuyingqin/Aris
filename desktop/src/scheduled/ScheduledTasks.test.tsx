// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import type { ScheduledDeliveryHistory, ScheduledTask, ScheduledTaskPreview } from "../types";
import ScheduledTasks from "./ScheduledTasks";
import { formatInZone, wallClockInZone } from "./scheduleFormat";

const {
  scheduledTasksList,
  scheduledTaskPreview,
  scheduledTaskHistory,
  scheduledTaskUpdate,
  scheduledTaskRunNow,
} = vi.hoisted(() => ({
  scheduledTasksList: vi.fn<() => Promise<ScheduledTask[]>>(),
  scheduledTaskPreview: vi.fn<(input: unknown) => Promise<ScheduledTaskPreview>>(),
  scheduledTaskHistory: vi.fn<(id: string) => Promise<ScheduledDeliveryHistory>>(),
  scheduledTaskUpdate: vi.fn(),
  scheduledTaskRunNow: vi.fn(),
}));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    isTauri: () => true,
    scheduledTasksList,
    scheduledTaskPreview,
    scheduledTaskHistory,
    scheduledTaskUpdate,
    scheduledTaskRunNow,
    scheduledTaskCreate: vi.fn(),
    scheduledTaskDelete: vi.fn(),
    scheduledTaskSetStatus: vi.fn(),
    chatUiSessionsList: vi.fn(async () => [
      { id: "chat-1", title: "Lab chat", projectId: "project-a", updatedAt: 1, turns: [] },
    ]),
    sessionsList: vi.fn(async () => []),
    mailAccountsGet: vi.fn(async () => []),
    chatModelOptions: vi.fn(async () => ({ provider: "", current: "", options: [] })),
    onScheduledTasksChanged: vi.fn(async () => () => undefined),
    onWorkTaskChanged: vi.fn(async () => () => undefined),
  };
});

/** 09:00 New York on the Friday before the 2026 spring-forward, and on the
 *  Monday after it: the same wall clock, an hour apart in UTC offset. */
const BEFORE_DST = Date.UTC(2026, 2, 6, 14, 0);
const AFTER_DST = Date.UTC(2026, 2, 9, 13, 0);

function cronTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "Weekday digest",
    prompt: "Summarize new papers.",
    status: "active",
    triggerKind: "schedule",
    scheduleKind: "cron",
    cron: "0 9 * * 1-5",
    timeZone: "America/New_York",
    targetMode: "session",
    sessionId: "chat-1",
    missedPolicy: "run_latest",
    nextRun: String(BEFORE_DST),
    nextOccurrences: [String(BEFORE_DST), String(AFTER_DST)],
    intervalValue: 15,
    intervalUnit: "minutes",
    updatedAt: "2",
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useStore.setState({
    language: "en",
    currentProject: {
      id: "project-a",
      name: "Project A",
      path: "C:/Project-A",
      addedAt: 1,
      lastOpenedAt: 1,
    },
    error: null,
  });
  scheduledTasksList.mockResolvedValue([cronTask()]);
  scheduledTaskPreview.mockResolvedValue({
    timeZone: "America/New_York",
    occurrences: [String(BEFORE_DST), String(AFTER_DST)],
  });
  scheduledTaskHistory.mockResolvedValue({ deliveries: [], earlierPruned: false });
});

afterEach(cleanup);

describe("schedule formatting", () => {
  it("formats an instant on the rule's own wall clock, with its offset", () => {
    expect(wallClockInZone(BEFORE_DST, "America/New_York")).toBe("2026-03-06T09:00");
    expect(wallClockInZone(AFTER_DST, "America/New_York")).toBe("2026-03-09T09:00");
    expect(wallClockInZone(BEFORE_DST, "Asia/Shanghai")).toBe("2026-03-06T22:00");
    expect(formatInZone(BEFORE_DST, "America/New_York", "en")).toMatch(/09:00.*GMT-5/);
    expect(formatInZone(AFTER_DST, "America/New_York", "en")).toMatch(/09:00.*GMT-4/);
  });
});

describe("ScheduledTasks", () => {
  it("previews the next occurrences in the chosen zone, across a DST change", async () => {
    render(<ScheduledTasks />);

    const list = await screen.findByRole("list", { name: "Next runs" });
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/09:00.*GMT-5/);
    expect(items[1]).toMatch(/09:00.*GMT-4/);
    expect(screen.getByText("Shown in America/New_York")).toBeTruthy();

    // The backend computes the preview from exactly the rule being edited.
    expect(scheduledTaskPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        triggerKind: "schedule",
        scheduleKind: "cron",
        cron: "0 9 * * 1-5",
        timeZone: "America/New_York",
      }),
    );
  });

  it("shows a rule the backend rejects instead of saving it", async () => {
    scheduledTaskPreview.mockRejectedValue("invalid Cron expression '61 * * * *'");
    scheduledTasksList.mockResolvedValue([cronTask({ cron: "61 * * * *" })]);
    render(<ScheduledTasks />);

    expect((await screen.findByRole("alert")).textContent).toContain("invalid Cron expression");
    expect((screen.getByRole("button", { name: /Save Changes/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps each delivery apart from the outcome of the work task it queued", async () => {
    scheduledTaskHistory.mockResolvedValue({
      earlierPruned: false,
      deliveries: [
        {
          key: "task-1:at:2",
          trigger: "schedule",
          occurrenceAt: AFTER_DST,
          coalesced: 3,
          status: "queued",
          recordedAt: AFTER_DST + 1_000,
          workTaskId: "card-2",
          targetSessionId: "chat-1",
          outcome: { status: "reviewing", reviewVerdict: null, sessionId: "chat-1" },
        },
        {
          key: "task-1:at:1",
          trigger: "schedule",
          occurrenceAt: BEFORE_DST,
          coalesced: 0,
          status: "missed",
          recordedAt: BEFORE_DST + 1_000,
          error: "1 occurrence(s) were missed",
          outcome: null,
        },
      ],
    });
    const onOpenSession = vi.fn();
    render(<ScheduledTasks onOpenSession={onOpenSession} />);

    const history = await screen.findByRole("list", { name: "Deliveries" });
    const [queued, missed] = within(history).getAllByRole("listitem");

    const queuedDelivery = within(queued).getByTestId("delivery");
    const queuedOutcome = within(queued).getByTestId("outcome");
    expect(within(queuedDelivery).getByText("Queued")).toBeTruthy();
    expect(within(queuedDelivery).getByText("3 missed run(s) folded in")).toBeTruthy();
    // "Queued" is not "done": the outcome is the card's own state.
    expect(within(queuedOutcome).getByText("Independent review")).toBeTruthy();
    expect(within(queuedOutcome).queryByText("Queued")).toBeNull();

    expect(within(within(missed).getByTestId("delivery")).getByText("Missed")).toBeTruthy();
    expect(within(within(missed).getByTestId("outcome")).getByText("No work task")).toBeTruthy();
    expect(within(missed).queryByRole("button", { name: /Open chat/ })).toBeNull();

    fireEvent.click(within(queued).getByRole("button", { name: /Open chat/ }));
    expect(onOpenSession).toHaveBeenCalledWith("chat-1", "Weekday digest");
  });

  it("maps a new-conversation target onto the save without a bound chat", async () => {
    scheduledTaskUpdate.mockResolvedValue(cronTask({ targetMode: "new", sessionId: null }));
    render(<ScheduledTasks />);

    await screen.findByRole("list", { name: "Next runs" });
    expect(screen.getByRole("combobox", { name: "Linked chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "New chat each run" }));
    expect(screen.queryByRole("combobox", { name: "Linked chat" })).toBeNull();
    expect(screen.getByText('Every run opens a new chat in "Project A".')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));
    await waitFor(() => expect(scheduledTaskUpdate).toHaveBeenCalled());
    expect(scheduledTaskUpdate).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        targetMode: "new",
        sessionId: "",
        projectId: "project-a",
        timeZone: "America/New_York",
        missedPolicy: "run_latest",
      }),
    );
  });
});
