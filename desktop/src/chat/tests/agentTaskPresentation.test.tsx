// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTaskCard } from "../../api/agentTasks";
import { AgentTaskElapsed, AgentTaskIdentity, agentTaskActivity, agentTaskDisplayName } from "../agentTaskPresentation";

const agent: AgentTaskCard = {
  sessionId: "agent-survey", rootSessionId: "chat-a", projectId: "project-a", path: "/root/survey_agent",
  status: { state: "running" }, pendingMail: 0, lastActivity: "read_file · evidence.md", interruptionReason: null,
  task: { reason: "Independent sources", task: "Check evidence", inputs: "Sources", deliverable: "Findings", stopCondition: "Evidence checked", model: "executor", connection: "local", permission: "read-only", workspace: "F:/Research", maxIterations: 4, maxSeconds: 300 },
  sessionPath: "survey.json", evidencePath: "survey.events.jsonl",
};
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("agent identity and presentation", () => {
  it("keeps identity across status changes, reorder, and remount", () => {
    const other = { ...agent, sessionId: "agent-limits" };
    const view = render(<><AgentTaskIdentity agent={agent} showStatus /><AgentTaskIdentity agent={other} /></>);
    const identity = () => document.querySelector('[data-agent-id="agent-survey"]')!.getAttribute("data-identity");
    const initial = identity();
    expect(initial).not.toBe(document.querySelector('[data-agent-id="agent-limits"]')!.getAttribute("data-identity"));
    view.rerender(<><AgentTaskIdentity agent={other} /><AgentTaskIdentity agent={{ ...agent, status: { state: "completed" } }} showStatus /></>);
    expect(identity()).toBe(initial);
    expect(document.querySelector('[data-agent-id="agent-survey"] .is-completed')).toBeTruthy();
    view.unmount();
    render(<AgentTaskIdentity agent={agent} />);
    expect(identity()).toBe(initial);
  });

  it("localizes known task labels and keeps arbitrary names readable without granting a reviewer role", () => {
    expect(agentTaskDisplayName(agent, "cn")).toBe("文献检索");
    expect(agentTaskDisplayName(agent, "en")).toBe("Literature search");
    expect(agentTaskDisplayName({ path: "/root/custom_probe_2" }, "cn")).toBe("Custom Probe 2");
    expect(agentTaskDisplayName({ path: "/root/constructor" }, "cn")).toBe("Constructor");
    expect(agentTaskDisplayName({ path: "/root/reviewer" }, "cn")).toBe("Reviewer");
  });

  it("shows the outcome instead of a stale activity after failure or completion", () => {
    expect(agentTaskActivity(agent, "cn")).toBe("读取文件 · evidence.md");
    expect(agentTaskActivity({ ...agent, status: { state: "errored", message: "checkpoint unavailable" } }, "cn")).toBe("checkpoint unavailable");
    expect(agentTaskActivity({ ...agent, status: { state: "completed" } }, "en")).toContain("Task completed");
    expect(agentTaskActivity({ ...agent, lastActivity: "custom_tool · source" }, "cn")).toBe("custom_tool · source");
    expect(agentTaskActivity({ ...agent, lastActivity: "constructor · source" }, "cn")).toBe("constructor · source");
  });

  it("ticks from the recorded start, freezes at the recorded end, and survives remount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const running = { ...agent, startedAt: 58_000 };
    const view = render(<AgentTaskElapsed agent={running} language="cn" />);
    expect(screen.getByText("42s")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("44s")).toBeTruthy();
    const completed = { ...running, finishedAt: 102_000, status: { state: "completed" as const } };
    view.rerender(<AgentTaskElapsed agent={completed} language="cn" />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("44s")).toBeTruthy();
    view.unmount();
    render(<AgentTaskElapsed agent={completed} language="en" />);
    expect(screen.getByText("44s")).toBeTruthy();
  });

  it("does not invent time for old records or an interrupted run without an end", () => {
    const view = render(<AgentTaskElapsed agent={agent} language="cn" />);
    expect(view.container.querySelector("time")).toBeNull();
    view.rerender(<AgentTaskElapsed agent={{ ...agent, startedAt: 1000, status: { state: "interrupted" } }} language="cn" />);
    expect(view.container.querySelector("time")).toBeNull();
  });
});
