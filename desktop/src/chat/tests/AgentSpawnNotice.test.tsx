// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTaskCard } from "../../api/agentTasks";
import type { ChatBlock } from "../../types";
import { AgentSpawnNotice, AgentTaskNavigation } from "../AgentSpawnNotice";

const agent: AgentTaskCard = {
  sessionId: "agent-a", rootSessionId: "chat-a", path: "/root/survey_agent", projectId: "project-a", status: { state: "running" }, pendingMail: 0,
  task: { reason: "Parallel evidence", task: "Check the sources", inputs: "Sources", deliverable: "Findings", stopCondition: "Sources checked", model: "executor", connection: "local", permission: "read-only", workspace: "F:/Research", maxIterations: 4, maxSeconds: 300 },
  lastActivity: null, interruptionReason: null, sessionPath: "agent.json", evidencePath: "agent.events.jsonl",
};
const spawn = (output?: string, isError = false): Extract<ChatBlock, { kind: "tool" }> => ({ kind: "tool", name: "spawn_agent", input: "{}", output, isError });
afterEach(cleanup);

describe("agent launch links", () => {
  it("links a successful durable result to the original child and the group to its directory", () => {
    const onOpenTask = vi.fn(), onOpenList = vi.fn();
    render(<AgentTaskNavigation.Provider value={{ rootSessionId: "chat-a", agents: [agent], language: "cn", onOpenList, onOpenTask }}>
      <AgentSpawnNotice blocks={[spawn(JSON.stringify({ sessionId: "agent-a" }))]} fallbacks={[<span key="raw">raw spawn</span>]} />
    </AgentTaskNavigation.Provider>);
    expect(screen.queryByText("raw spawn")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文献检索" }));
    expect(onOpenTask).toHaveBeenCalledWith(agent);
    fireEvent.click(screen.getByRole("button", { name: "查看子智能体" }));
    expect(onOpenList).toHaveBeenCalledTimes(1);
  });

  it("keeps failed, incomplete, malformed and foreign-session results in their original order", () => {
    const blocks = [spawn(undefined), spawn('{"sessionId":"agent-a"}', true), spawn("invalid JSON"), spawn('{"sessionId":"agent-foreign"}'), spawn('{"sessionId":"agent-a"}')];
    const view = render(<AgentTaskNavigation.Provider value={{ rootSessionId: "chat-a", agents: [agent, { ...agent, sessionId: "agent-foreign", rootSessionId: "chat-other" }], language: "en", onOpenList: vi.fn(), onOpenTask: vi.fn() }}>
      <AgentSpawnNotice blocks={blocks} fallbacks={blocks.map((_, i) => <span key={i}>raw {i}</span>)} />
    </AgentTaskNavigation.Provider>);
    const content = view.container.textContent!;
    expect(content.indexOf("raw 0")).toBeLessThan(content.indexOf("raw 1"));
    expect(content.indexOf("raw 1")).toBeLessThan(content.indexOf("raw 2"));
    expect(content.indexOf("raw 3")).toBeLessThan(content.indexOf("Literature search"));
    expect(screen.queryByText("raw 4")).toBeNull();
    expect(screen.getAllByRole("group", { name: "Delegated agents" })).toHaveLength(1);
  });

  it("enables the link when the matching snapshot arrives and removes it on session switch", () => {
    const block = spawn('{"sessionId":"agent-a"}');
    const renderNotice = (rootSessionId: string, agents: AgentTaskCard[]) => <AgentTaskNavigation.Provider value={{ rootSessionId, agents, language: "en", onOpenList: vi.fn(), onOpenTask: vi.fn() }}>
      <AgentSpawnNotice blocks={[block]} fallbacks={[<span key="raw">raw result</span>]} />
    </AgentTaskNavigation.Provider>;
    const view = render(renderNotice("chat-a", []));
    expect(screen.getByText("raw result")).toBeTruthy();
    view.rerender(renderNotice("chat-a", [agent]));
    expect(screen.getByRole("button", { name: "Literature search" })).toBeTruthy();
    view.rerender(renderNotice("chat-other", [agent]));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByText("raw result")).toBeTruthy();
  });
});
