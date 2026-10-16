// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBlock, ChatTurn } from "../../types";
import { useStore } from "../../store";
import ChatMessage from "../ChatMessage";
import { patchLastAssistantTurn } from "../model";
import {
  formatWaitClock,
  MODEL_WAIT_VISIBLE_AFTER_MS,
  modelWaitElapsedMs,
  noteTurnActivity,
} from "../modelWait";

vi.mock("../../api/tauri", () => ({
  chatChangeRevert: vi.fn(),
  codeBridgeOpenFile: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  isTauri: vi.fn(() => false),
}));

beforeEach(() => {
  useStore.setState({ tab: "chat", language: "en" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function streamingTurn(blocks: ChatBlock[], at: number): ChatTurn {
  noteTurnActivity(blocks, at);
  return { id: `turn-${at}-${blocks.length}`, role: "assistant", blocks, streaming: true };
}

function renderTurn(turn: ChatTurn) {
  return render(
    <ChatMessage
      turn={turn}
      canRetry={false}
      onEdit={() => undefined}
      onRetry={() => undefined}
      onContinue={() => undefined}
    />,
  );
}

describe("formatWaitClock", () => {
  it("reads like a stopwatch", () => {
    expect(formatWaitClock(0)).toBe("0:00");
    expect(formatWaitClock(7_900)).toBe("0:07");
    expect(formatWaitClock(151_000)).toBe("2:31");
    expect(formatWaitClock(3_849_000)).toBe("1:04:09");
    expect(formatWaitClock(-5)).toBe("0:00");
    expect(formatWaitClock(Number.NaN)).toBe("0:00");
  });
});

describe("modelWaitElapsedMs", () => {
  const start = 1_000_000;

  it("stays hidden through ordinary token gaps, then counts from the last activity", () => {
    const turn = streamingTurn([{ kind: "text", text: "partial" }], start);
    expect(modelWaitElapsedMs(turn, start + MODEL_WAIT_VISIBLE_AFTER_MS - 1)).toBeNull();
    expect(modelWaitElapsedMs(turn, start + 150_000)).toBe(150_000);
  });

  it("restarts when the stream produces anything new", () => {
    vi.useFakeTimers();
    const first = streamingTurn([], start);
    const [next] = patchLastAssistantTurn([first], (turn) => ({
      ...turn,
      blocks: [...turn.blocks, { kind: "thinking", thinking: "…" }],
    }));
    const now = Date.now();
    expect(modelWaitElapsedMs(next, now + 1_000)).toBeNull();
    expect(modelWaitElapsedMs(next, now + 5_000)).toBe(5_000);
  });

  it("defers to surfaces that already show their own live status", () => {
    const later = start + 600_000;
    const cases: ChatBlock[][] = [
      [{ kind: "tool", id: "t1", name: "Bash", input: "{}" }],
      [{ kind: "tool", id: "q1", name: "AskUserQuestion", input: "{}" }],
      [{
        kind: "permission",
        id: "p1",
        toolName: "Bash",
        input: "{}",
        currentMode: "read-only",
        requiredMode: "workspace-write",
        status: "pending",
      }],
      [{ kind: "review", phase: "reviewing", attempt: 1, maxRevisions: 2 }],
      [{ kind: "notice", message: "retrying", retry: { resumeAt: later + 5_000, count: 1 } }],
    ];
    for (const blocks of cases) {
      expect(modelWaitElapsedMs(streamingTurn(blocks, start), later)).toBeNull();
    }
  });

  it("resumes counting once a retry backoff has run out", () => {
    const turn = streamingTurn(
      [{ kind: "notice", message: "retrying", retry: { resumeAt: start + 4_000, count: 1 } }],
      start,
    );
    expect(modelWaitElapsedMs(turn, start + 3_500)).toBeNull();
    expect(modelWaitElapsedMs(turn, start + 90_000)).toBe(90_000);
  });

  it("is silent for finished or user turns", () => {
    const blocks: ChatBlock[] = [];
    noteTurnActivity(blocks, start);
    expect(modelWaitElapsedMs({ id: "a", role: "assistant", blocks }, start + 60_000)).toBeNull();
    expect(modelWaitElapsedMs({ id: "u", role: "user", blocks, streaming: true }, start + 60_000))
      .toBeNull();
  });
});

describe("ModelWaitIndicator", () => {
  it("shows a ticking clock under a silent streaming turn and explains long waits", () => {
    vi.useFakeTimers();
    const turn = streamingTurn([], Date.now());
    renderTurn(turn);
    expect(screen.queryByText(/Waiting for the model/)).toBeNull();

    act(() => { vi.advanceTimersByTime(4_000); });
    expect(screen.getByText(/Waiting for the model/)).toBeTruthy();
    expect(screen.getByText("0:04")).toBeTruthy();
    expect(screen.queryByText(/this is not a hang/)).toBeNull();

    act(() => { vi.advanceTimersByTime(147_000); });
    expect(screen.getByText("2:31")).toBeTruthy();
    expect(screen.getByText(/this is not a hang/)).toBeTruthy();
  });

  it("keeps the real elapsed time across an unmount, e.g. virtualized scrolling", () => {
    vi.useFakeTimers();
    const turn = streamingTurn([], Date.now());
    const first = renderTurn(turn);
    act(() => { vi.advanceTimersByTime(90_000); });
    first.unmount();

    act(() => { vi.advanceTimersByTime(30_000); });
    renderTurn(turn);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByText("2:01")).toBeTruthy();
  });

  it("uses the Chinese copy", () => {
    vi.useFakeTimers();
    useStore.setState({ language: "cn" });
    renderTurn(streamingTurn([], Date.now()));
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText("等待模型响应 · 已")).toBeTruthy();
    expect(screen.getByText("0:05")).toBeTruthy();
  });

  it("disappears once the turn is no longer streaming", () => {
    vi.useFakeTimers();
    const turn = streamingTurn([], Date.now());
    const view = renderTurn(turn);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText(/Waiting for the model/)).toBeTruthy();
    view.rerender(
      <ChatMessage
        turn={{ ...turn, streaming: false, blocks: [{ kind: "text", text: "done" }] }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(screen.queryByText(/Waiting for the model/)).toBeNull();
  });
});
