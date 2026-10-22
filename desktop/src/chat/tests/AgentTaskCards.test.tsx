// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTaskCard, AgentTaskDetail } from "../../api/agentTasks";
import AgentTaskCards, { AgentTaskList } from "../AgentTaskCards";
import AgentTaskPanel from "../AgentTaskPanel";
import { useAgentTasks } from "../useAgentTasks";

const api = vi.hoisted(() => ({ list: vi.fn(), interrupt: vi.fn(), detail: vi.fn(), trace: vi.fn(), unsubscribe: vi.fn(),
  receive: null as null | ((e: { sessionId: string; agents: AgentTaskCard[] }) => void),
  activity: null as null | ((e: { sessionId: string; childSessionId: string; activity: string; revision?: number }) => void),
}));
vi.mock("../../api/agentTasks", () => ({
  chatAgentList: api.list, chatAgentInterrupt: api.interrupt, chatAgentDetail: api.detail, chatAgentTrace: api.trace,
  onChatAgents: (handler: typeof api.receive) => { api.receive = handler; return Promise.resolve(api.unsubscribe); },
  onChatAgentActivity: (handler: typeof api.activity) => { api.activity = handler; return Promise.resolve(api.unsubscribe); },
}));
vi.mock("../ChatMessage", () => ({ default: ({ turn, canRetry }: { turn: { role: string; readOnly?: boolean; blocks: { kind: string; text?: string }[] }; canRetry: boolean }) =>
  <article data-testid="agent-message" data-role={turn.role} data-readonly={turn.readOnly} data-retry={canRetry}>{turn.blocks.map(block => block.text).join(" ")}</article>,
}));
const task: AgentTaskCard = {
  revision: 1, sessionId: "agent-a", rootSessionId: "chat-a", path: "/root/backend", projectId: "project-a", status: { state: "pending_init" }, pendingMail: 1,
  task: { reason: "独立核对恢复与同步", task: "检查后端恢复", inputs: "已有检查点", deliverable: "证据路径与缺口", stopCondition: "确认投递边界", model: "configured-executor", connection: "openai-compatible / gateway.example", permission: "workspace-write intersect read-only", workspace: "F:/Research", maxIterations: 12, maxSeconds: 300 },
  lastActivity: null, interruptionReason: null, sessionPath: "F:/Research/agents/a.json", evidencePath: "F:/Research/agents/a.events.jsonl",
};
const onEvidence = vi.fn();
const onResume = vi.fn();
function Harness({ sessionId = "chat-a" }: { sessionId?: string }) {
  const state = useAgentTasks(sessionId, "project-a", false, true);
  const [selected, select] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  return <>
    <AgentTaskCards agents={state.agents} error={state.error} language="cn" onOpenList={() => setListOpen(true)} />
    {listOpen && <section aria-label="子任务列表"><AgentTaskList agents={state.agents} error={state.error} language="cn" onOpenTask={agent => select(agent.sessionId)} /></section>}
    {selected && <AgentTaskPanel sessionId={sessionId} projectId="project-a" childSessionId={selected}
      agent={state.agents.find(agent => agent.sessionId === selected)} language="cn" visible busy={false}
      stopping={state.stopping === selected} error={state.error} onStop={agent => void state.stop(agent)} onResume={onResume} onOpenEvidence={onEvidence} />}
  </>;
}
const summary = () => within(screen.getByRole("region", { name: "子智能体" }));
const list = () => within(screen.getByRole("region", { name: "子任务列表" }));
const openList = async () => fireEvent.click(await screen.findByRole("button", { name: "查看子智能体" }));
const open = async () => {
  if (!screen.queryByRole("region", { name: "子任务列表" })) await openList();
  fireEvent.click(await screen.findByRole("button", { name: "打开子任务 后端核查" }));
};
beforeEach(() => {
  vi.resetAllMocks(); api.receive = null; api.activity = null;
  api.list.mockResolvedValue([task]); api.interrupt.mockResolvedValue(undefined);
  api.detail.mockResolvedValue({ transcript: "read_file: recovery.rs" });
});
afterEach(cleanup);

describe("agent summary and child workspace", () => {
  it("keeps a checkpoint failure visible while the directory is collapsed", async () => {
    api.list.mockResolvedValue([{ ...task, persistenceError: "checkpoint could not be saved" }]);
    render(<Harness />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(summary().getByText("checkpoint could not be saved")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "子任务列表" })).toBeNull();
  });

  it("opens the original child on demand while keeping the summary compact", async () => {
    render(<Harness />);
    expect(await screen.findByText("1 个进行中")).toBeTruthy();
    expect(summary().queryByText(/独立核对恢复与同步/)).toBeNull();
    expect(summary().queryByText("检查后端恢复")).toBeNull();
    expect(summary().queryByText("/root")).toBeNull();
    expect(api.detail).not.toHaveBeenCalled();
    await open();
    expect(await screen.findByText("read_file: recovery.rs")).toBeTruthy();
    fireEvent.click(screen.getByText("任务详情"));
    expect(screen.getByText(/configured-executor/)).toBeTruthy();
    expect(screen.getByText("独立核对恢复与同步")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "执行证据" }));
    expect(onEvidence).toHaveBeenCalledWith(task.evidencePath);
    expect(api.detail).toHaveBeenCalledWith("chat-a", "project-a", "agent-a");
    expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("updates real activity and failure without polling or putting long results in the summary", async () => {
    render(<Harness />);
    await openList();
    await screen.findByText("排队");
    act(() => api.activity?.({ sessionId: "chat-a", childSessionId: "agent-a", activity: "read_file: recovery.rs", revision: 2 }));
    expect(list().getByText("读取文件 · recovery.rs")).toBeTruthy();
    act(() => api.receive?.({ sessionId: "chat-a", agents: [{ ...task, revision: 3, status: { state: "errored", message: "connection refused" } }] }));
    expect(list().getByText("失败")).toBeTruthy();
    expect(list().getByText("connection refused")).toBeTruthy();
    expect(summary().getByText("1 个失败")).toBeTruthy();
    expect(screen.queryByText("运行中")).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(1);
    await open();
    expect((await screen.findByRole("alert")).textContent).toContain("connection refused");
  });

  it("stops the actual child and permits explicit continuation after restart", async () => {
    api.list.mockResolvedValueOnce([{ ...task, status: { state: "running" } }]).mockResolvedValue([{ ...task, revision: 2, status: { state: "interrupted" }, interruptionReason: "application exited; no replay" }]);
    render(<Harness />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith("chat-a", "project-a", "/root/backend"));
    await screen.findByText("application exited; no replay");
    fireEvent.click(screen.getByRole("button", { name: "继续原任务" }));
    expect(onResume).toHaveBeenCalledWith("/root/backend");
  });

  it("does not let a delayed initial read overwrite a newer completed result", async () => {
    let finish!: (items: AgentTaskCard[]) => void;
    api.list.mockImplementation(() => new Promise<AgentTaskCard[]>(resolve => { finish = resolve; }));
    render(<Harness />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    act(() => api.receive?.({ sessionId: "chat-a", agents: [{ ...task, revision: 5, status: { state: "completed", message: "confirmed evidence" } }] }));
    await act(async () => finish([task]));
    await openList();
    expect(list().getByText("已完成")).toBeTruthy();
    expect(list().getByText("confirmed evidence")).toBeTruthy();
    expect(list().queryByText("排队")).toBeNull();
  });

  it("ignores out-of-order snapshots, retired activity, and other root sessions", async () => {
    render(<Harness />);
    await openList();
    await screen.findByText("排队");
    act(() => api.receive?.({ sessionId: "chat-a", agents: [{ ...task, revision: 5, status: { state: "completed" }, lastActivity: "confirmed evidence" }] }));
    act(() => api.receive?.({ sessionId: "chat-a", agents: [{ ...task, revision: 2, status: { state: "running" } }] }));
    act(() => api.activity?.({ sessionId: "chat-a", childSessionId: "agent-a", activity: "stale tool", revision: 3 }));
    act(() => api.receive?.({ sessionId: "chat-other", agents: [{ ...task, revision: 6, status: { state: "errored" } }] }));
    expect(list().getByText("已完成")).toBeTruthy();
    expect(list().getByText("任务已完成，可查看结果")).toBeTruthy();
    expect(screen.queryByText("stale tool")).toBeNull();
    expect(screen.queryByText("运行中")).toBeNull();
  });

  it("still loads cards when activity arrives before their first snapshot", async () => {
    let finish!: (items: AgentTaskCard[]) => void;
    api.list.mockImplementation(() => new Promise<AgentTaskCard[]>(resolve => { finish = resolve; }));
    render(<Harness />);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    act(() => api.activity?.({ sessionId: "chat-a", childSessionId: "agent-a", activity: "read_file" }));
    await act(async () => finish([task]));
    await openList();
    expect(await screen.findByText("排队")).toBeTruthy();
    expect(screen.getByText("检查后端恢复")).toBeTruthy();
  });

  it("renders saved conversation with shared chat blocks and refreshes after execution events", async () => {
    api.detail.mockResolvedValue({ transcript: "", turns: [{ id: "answer", role: "assistant", blocks: [{ kind: "text", text: "检查点已保存" }] }] });
    render(<Harness />);
    await open();
    expect(await screen.findByText("检查点已保存")).toBeTruthy();
    expect(screen.getByTestId("agent-message").getAttribute("data-readonly")).toBe("true");
    expect(screen.getByTestId("agent-message").getAttribute("data-retry")).toBe("false");
    api.detail.mockResolvedValue({ transcript: "", turns: [{ id: "answer", role: "assistant", blocks: [{ kind: "text", text: "完成证据核查" }] }] });
    act(() => api.receive?.({ sessionId: "chat-a", agents: [{ ...task, revision: 2, status: { state: "completed" } }] }));
    expect(await screen.findByText("完成证据核查")).toBeTruthy();
    expect(api.detail).toHaveBeenCalledTimes(2);
  });

  it("shows a durable execution timeline in the child activity view", async () => {
    api.detail.mockResolvedValue({ transcript: "saved evidence", timeline: [
      { seq: 1, ts: 1000, kind: "agent.turn.started" },
      { seq: 2, ts: 2000, kind: "agent.tool.finished", toolName: "read_file", isError: false },
      { seq: 3, ts: 3000, kind: "agent.interrupted", reason: "application exited" },
    ] });
    render(<Harness />);
    await open();
    await screen.findByText("saved evidence");
    fireEvent.click(screen.getByRole("tab", { name: "运行记录" }));
    expect(screen.getByLabelText("执行时间线")).toBeTruthy();
    expect(screen.getByText("开始执行")).toBeTruthy();
    expect(screen.getByText("工具调用完成 · read_file")).toBeTruthy();
    expect(screen.getByText("application exited")).toBeTruthy();
  });

  it("keeps the saved conversation on a refresh error and supports retry", async () => {
    render(<Harness />);
    await open();
    await screen.findByText("read_file: recovery.rs");
    api.detail.mockRejectedValueOnce(new Error("checkpoint unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "刷新子会话" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("read_file: recovery.rs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新子会话" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("discards a delayed conversation response after a different child is selected", async () => {
    let finish!: (detail: AgentTaskDetail) => void;
    api.detail.mockImplementationOnce(() => new Promise<AgentTaskDetail>(resolve => { finish = resolve; }));
    const props = { sessionId: "chat-a", projectId: "project-a", childSessionId: "agent-a", language: "cn" as const, visible: true, busy: false, stopping: false, onStop: vi.fn(), onResume, onOpenEvidence: onEvidence };
    const view = render(<AgentTaskPanel {...props} />);
    await waitFor(() => expect(api.detail).toHaveBeenCalledTimes(1));
    api.detail.mockResolvedValue({ transcript: "new child evidence" });
    view.rerender(<AgentTaskPanel {...props} childSessionId="agent-b" />);
    await screen.findByText("new child evidence");
    await act(async () => finish({ transcript: "stale child evidence" }));
    expect(screen.queryByText("stale child evidence")).toBeNull();
    expect(screen.getByText("new child evidence")).toBeTruthy();
  });

  it("keeps task state isolated when switching the main conversation", async () => {
    const view = render(<Harness />);
    await openList();
    await screen.findByText("排队");
    const oldListener = api.receive;
    api.list.mockResolvedValue([]);
    view.rerender(<Harness sessionId="chat-b" />);
    act(() => oldListener?.({ sessionId: "chat-a", agents: [{ ...task, revision: 8, status: { state: "running" } }] }));
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("chat-b", "project-a"));
    expect(screen.queryByRole("region", { name: "子智能体" })).toBeNull();
    expect(api.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("traces a result back through the child's tool calls to the parent's spawn call", async () => {
    api.trace.mockResolvedValue({
      rootSessionId: "chat-a",
      nodes: [
        { sessionId: "chat-a", path: "/root", depth: 0, turns: [] },
        { sessionId: "agent-a", path: "/root/backend", parentSessionId: "chat-a", depth: 1, turns: [{
          turnId: "child-turn-one", status: "completed", received: ["mail-task"], sent: ["mail-result"],
          tools: [{ toolUseId: "toolu_read", toolName: "read_file", finishedTs: 2, isError: false }, { toolUseId: "toolu_grep", toolName: "grep_search", finishedTs: 3, isError: true }],
        }] },
      ],
      edges: [
        { id: "spawn:agent-a", kind: "spawn_agent", fromSessionId: "chat-a", fromPath: "/root", toSessionId: "agent-a", toPath: "/root/backend", sourceTurnId: "turn-parent", sourceToolUseId: "toolu_spawn" },
        { id: "mail-task", kind: "assign_task", fromSessionId: "chat-a", fromPath: "/root", toSessionId: "agent-a", toPath: "/root/backend", sourceTurnId: "turn-parent", sourceToolUseId: "toolu_spawn", deliveredTurnId: "child-turn-one" },
        { id: "mail-result", kind: "agent_result", fromSessionId: "agent-a", fromPath: "/root/backend", toSessionId: "chat-a", toPath: "/root", sourceTurnId: "child-turn-one", status: "completed", deliveredTurnId: "turn-parent-2" },
      ],
    });
    render(<Harness />);
    await open();
    expect(api.trace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "追溯" }));
    await screen.findByLabelText("交互追溯");
    expect(api.trace).toHaveBeenCalledWith("chat-a", "project-a");
    const tools = within(screen.getByRole("region", { name: "工具调用" }));
    expect(tools.getByText("read_file")).toBeTruthy();
    expect(tools.getByText("失败")).toBeTruthy();
    const read = within(screen.getByRole("region", { name: "读取" }));
    expect(read.getByText("任务")).toBeTruthy();
    expect(read.getByTitle("toolu_spawn")).toBeTruthy();
    const sent = within(screen.getByRole("region", { name: "发出" }));
    expect(sent.getByText("结果")).toBeTruthy();
    expect(sent.getByTitle("turn-parent-2")).toBeTruthy();
  });

  it("shows a trace read failure without leaving the panel", async () => {
    api.trace.mockRejectedValue(new Error("event log unreadable"));
    render(<Harness />);
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "追溯" }));
    expect(await screen.findByText(/event log unreadable/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "对话" })).toBeTruthy();
  });
});
