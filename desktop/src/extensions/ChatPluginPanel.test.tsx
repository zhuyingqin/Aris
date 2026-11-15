// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import { openExternalUrl } from "../api/tauri";
import ChatPluginPanel from "./ChatPluginPanel";
import { fillPrompt, niceTicks } from "./ChatPluginDataWidgets";

vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()), pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(),
}));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../chat/MarkdownContent", () => ({ default: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div> }));
const panel: api.ActiveUiPanel = {
  pluginName: "@lab/desk", packageDigest: "abc", id: "desk", slot: "chat.sidebar", order: 0,
  title: { cn: "研究清单", en: "Research checklist" },
  widgets: [
    { id: "intro", type: "text", text: "Your own research workspace" },
    { id: "todos", type: "todo-list", title: "My todos" },
    { id: "notes", type: "notes", title: "Research notes" },
    { id: "plan", type: "agent-plan", title: "Execution progress" },
  ],
};
const empty = (): api.UiPanelState => ({ revision: 0, todoLists: {}, notes: {} });
const props = { panel, projectPath: "F:/project", sessionId: "session-a", language: "en" as const, agentTodos: [] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.pluginsUiStateGet).mockResolvedValue(empty());
});
afterEach(cleanup);

describe("Chat plugin panels", () => {
  it("does not save personal data under the shared new-chat draft", async () => {
    render(<ChatPluginPanel {...props} sessionId="chat-home" />);
    expect(screen.getByText("Send your first message to add todos and notes saved with this conversation.")).toBeTruthy();
    expect(screen.queryByLabelText("New todo")).toBeNull();
    expect(api.pluginsUiStateGet).not.toHaveBeenCalled();
  });
  it("adds, checks and removes a personal todo using the scoped revision API", async () => {
    vi.mocked(api.pluginsUiStateUpdate)
      .mockResolvedValueOnce({ revision: 1, todoLists: { todos: [{ id: "t1", text: "Check sources", completed: false }] }, notes: {} })
      .mockResolvedValueOnce({ revision: 2, todoLists: { todos: [{ id: "t1", text: "Check sources", completed: true }] }, notes: {} })
      .mockResolvedValueOnce({ revision: 3, todoLists: { todos: [] }, notes: {} });
    render(<ChatPluginPanel {...props} />);
    fireEvent.change(await screen.findByLabelText("New todo"), { target: { value: "Check sources" } });
    fireEvent.click(screen.getByRole("button", { name: "Add todo" }));
    const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Check sources" });
    expect(api.pluginsUiStateUpdate).toHaveBeenNthCalledWith(1, "F:/project", "@lab/desk", "desk", "session-a", 0, { type: "todoAdd", widgetId: "todos", text: "Check sources" });
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    fireEvent.click(checkbox);
    const completedToggle = await screen.findByRole("button", { name: "Completed 1" });
    expect(screen.queryByRole("checkbox", { name: "Check sources" })).toBeNull();
    expect(screen.getByRole("progressbar", { name: "My todos" }).getAttribute("aria-valuenow")).toBe("1");
    fireEvent.click(completedToggle);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Check sources" }).checked).toBe(true);
    expect(api.pluginsUiStateUpdate).toHaveBeenNthCalledWith(2, "F:/project", "@lab/desk", "desk", "session-a", 1, { type: "todoSetCompleted", widgetId: "todos", itemId: "t1", completed: true });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Delete: Check sources" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete: Check sources" }));
    await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
  });

  it("keeps todo and unsaved note drafts when folding sections with the keyboard", async () => {
    const user = userEvent.setup();
    render(<ChatPluginPanel {...props} />);
    const newTodo = await screen.findByLabelText<HTMLInputElement>("New todo");
    fireEvent.change(newTodo, { target: { value: "Keep this next step" } });
    const todoHeader = screen.getByRole("button", { name: "My todos" });
    todoHeader.focus();
    await user.keyboard("{Enter}");
    expect(todoHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "New todo" })).toBeNull();
    await user.keyboard(" ");
    expect(todoHeader.getAttribute("aria-expanded")).toBe("true");
    expect(newTodo.value).toBe("Keep this next step");
    const notes = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Research notes" });
    fireEvent.change(notes, { target: { value: "A lead to follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Research notes" }));
    expect(screen.queryByRole("textbox", { name: "Research notes" })).toBeNull();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Research notes" }));
    expect(notes.value).toBe("A lead to follow up");
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
  });

  it("saves notes with Ctrl or Command + Enter, excluding input method composition", async () => {
    vi.mocked(api.pluginsUiStateUpdate)
      .mockResolvedValueOnce({ revision: 1, todoLists: {}, notes: { notes: "First lead" } })
      .mockResolvedValueOnce({ revision: 2, todoLists: {}, notes: { notes: "Second lead" } });
    render(<ChatPluginPanel {...props} />);
    const notes = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Research notes" });
    fireEvent.change(notes, { target: { value: "First lead" } });
    fireEvent.keyDown(notes, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(notes, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(api.pluginsUiStateUpdate).toHaveBeenLastCalledWith("F:/project", "@lab/desk", "desk", "session-a", 0, { type: "notesSet", widgetId: "notes", text: "First lead" });
    fireEvent.change(notes, { target: { value: "Second lead" } });
    fireEvent.keyDown(notes, { key: "Enter", metaKey: true });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(api.pluginsUiStateUpdate).toHaveBeenLastCalledWith("F:/project", "@lab/desk", "desk", "session-a", 1, { type: "notesSet", widgetId: "notes", text: "Second lead" });
  });

  it("counts every active agent step and keeps the summary when collapsed", async () => {
    render(<ChatPluginPanel {...props} agentTodos={[
      { content: "Collect sources", activeForm: "Collecting sources", status: "completed" },
      { content: "Read paper", activeForm: "Reading paper", status: "in_progress" },
      { content: "Verify data", activeForm: "Verifying data", status: "in_progress" },
      { content: "Write findings", activeForm: "Writing findings", status: "pending" },
    ]} />);
    const plan = screen.getByRole("region", { name: "Execution progress" });
    expect(within(plan).getAllByRole("img", { name: "In progress" })).toHaveLength(2);
    expect(within(plan).getByText("1 Completed · 2 In progress · 1 Pending")).toBeTruthy();
    fireEvent.click(within(plan).getByRole("button", { name: "Execution progress" }));
    expect(within(plan).queryByRole("list")).toBeNull();
    expect(within(plan).getAllByText("1 Completed · 2 In progress · 1 Pending").some((element) => !element.closest("[hidden]"))).toBe(true);
    expect(within(plan).getByText("Read only")).toBeTruthy();
    await screen.findByLabelText("New todo");
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
  });

  it("retains notes after a conflict and lets the user reload and save deliberately", async () => {
    vi.mocked(api.pluginsUiStateUpdate).mockRejectedValueOnce(new Error("State changed in another window; reload"))
      .mockResolvedValueOnce({ revision: 5, todoLists: {}, notes: { notes: "My draft" } });
    const view = render(<ChatPluginPanel {...props} />);
    const textarea = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Research notes" });
    fireEvent.change(textarea, { target: { value: "My draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await screen.findByRole("alert");
    expect(textarea.value).toBe("My draft");
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue({ revision: 4, todoLists: {}, notes: { notes: "Other window's notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save notes" }).disabled).toBe(false));
    expect(textarea.value).toBe("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(api.pluginsUiStateUpdate).toHaveBeenLastCalledWith("F:/project", "@lab/desk", "desk", "session-a", 4, { type: "notesSet", widgetId: "notes", text: "My draft" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    view.unmount();
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue({ revision: 5, todoLists: {}, notes: { notes: "My draft" } });
    render(<ChatPluginPanel {...props} />);
    expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Research notes" })).value).toBe("My draft");
  });

  it("discards delayed state and save results when the project or session changes", async () => {
    let resolveOld!: (state: api.UiPanelState) => void;
    vi.mocked(api.pluginsUiStateGet).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(empty());
    const view = render(<ChatPluginPanel {...props} />);
    view.rerender(<ChatPluginPanel {...props} projectPath="F:/other" sessionId="session-b" />);
    await screen.findByLabelText("New todo");
    await act(async () => resolveOld({ revision: 8, todoLists: { todos: [{ id: "old", text: "Old private todo", completed: false }] }, notes: {} }));
    expect(screen.queryByText("Old private todo")).toBeNull();
    let resolveSave!: (state: api.UiPanelState) => void;
    vi.mocked(api.pluginsUiStateUpdate).mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    fireEvent.change(screen.getByLabelText("New todo"), { target: { value: "Old save" } });
    fireEvent.click(screen.getByRole("button", { name: "Add todo" }));
    view.rerender(<ChatPluginPanel {...props} sessionId="session-c" />);
    await screen.findByLabelText("New todo");
    await act(async () => resolveSave({ revision: 1, todoLists: { todos: [{ id: "t1", text: "Old save", completed: false }] }, notes: {} }));
    expect(screen.queryByText("Old save")).toBeNull();
  });

  it("shows the existing agent plan as read only and renders package text as text", async () => {
    render(<ChatPluginPanel {...props} panel={{ ...panel, widgets: [...panel.widgets, { id: "text", type: "text", text: "<script>invoke('shell')</script>" }] }}
      agentTodos={[{ content: "Run experiment", activeForm: "Running experiment", status: "in_progress" }, { content: "Gather sources", activeForm: "Gathering sources", status: "completed" }]} />);
    const plan = screen.getByRole("region", { name: "Execution progress" });
    expect(within(plan).getByText("Running experiment")).toBeTruthy();
    expect(within(plan).queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("<script>invoke('shell')</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    await screen.findByLabelText("New todo");
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
  });

  it("offers retry after a read failure without presenting an empty checklist as saved", async () => {
    vi.mocked(api.pluginsUiStateGet).mockRejectedValueOnce(new Error("Corrupt state")).mockResolvedValueOnce(empty());
    render(<ChatPluginPanel {...props} />);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("New todo")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await screen.findByLabelText("New todo");
  });

  const board: api.ActiveUiPanel = {
    pluginName: "@local/board", packageDigest: "d1", id: "board", slot: "chat.sidebar", order: 0, scope: "project", title: "Board",
    widgets: [
      { id: "summary", type: "metrics", title: "Summary" },
      { id: "progress", type: "progress", title: "Progress" },
      { id: "runs", type: "table", title: "Runs", columns: [{ key: "name", title: "Run" }, { key: "acc", title: "Accuracy" }] },
      { id: "trend", type: "chart", title: "Trend", chart: "line" },
      { id: "findings", type: "markdown", title: "Findings" },
      { id: "files", type: "list", title: "Files" },
      { id: "ask", type: "form", title: "New run", fields: [
        { key: "model", label: "Model", input: "select", options: ["small", "large"] },
        { key: "seeds", label: "Seeds", input: "number" },
        { key: "ablate", label: "Ablation", input: "checkbox" },
      ], submit: { label: "Plan it", action: { type: "prompt", text: "Plan a {{model}} run with {{ seeds }} seeds; ablation: {{ablate}}." } } },
      { id: "refresh", type: "button", label: "Refresh board", action: { type: "prompt", text: "Refresh the board", send: true } },
      { id: "open", type: "button", label: "Open log", action: { type: "open-file", path: "results/log.md" } },
    ],
  };
  const filled = (): api.UiPanelState => ({
    revision: 3, todoLists: {}, notes: {},
    data: {
      summary: [{ label: "Accuracy", value: "81.2%", hint: "3 seeds", tone: "good" }, { label: "Runs", value: 12 }],
      progress: { value: 0.5, label: "6 of 12" },
      runs: [{ name: "baseline", acc: 0.81 }, { name: "ours", acc: null }],
      trend: { labels: ["e1", "e2", "e3"], series: [{ name: "loss", values: [1.5, null, 0.5] }, { name: "val", values: [2, 1, 1] }] },
      findings: "## Result",
      files: [{ title: "Table 2", tag: "csv", path: "results/table2.csv" }, { title: "Paper", url: "https://arxiv.org/abs/1706.03762" }, { title: "Plain" }],
    },
  });

  it("shows a project panel on the home draft and renders what the agent wrote", async () => {
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue(filled());
    const onOpenFile = vi.fn();
    render(<ChatPluginPanel {...props} panel={board} sessionId="chat-home" onOpenFile={onOpenFile} />);
    const runs = await screen.findByRole("region", { name: "Runs" });
    // One copy for the project: read under no session at all.
    expect(api.pluginsUiStateGet).toHaveBeenCalledWith("F:/project", "@local/board", "board", "");
    expect(screen.getByText("Shared by this project · Saved locally")).toBeTruthy();
    expect(within(runs).getAllByRole("row")).toHaveLength(3);
    expect(within(runs).getByText("0.81")).toBeTruthy();
    expect(within(runs).getByText("–")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Summary" })).getByText("81.2%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Progress" }).getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByTestId("markdown").textContent).toBe("## Result");
    const trend = screen.getByRole("region", { name: "Trend" });
    expect(within(trend).getByRole("img", { name: "Trend: loss, val" })).toBeTruthy();
    // The same numbers as a table, with the gap shown as a gap.
    expect(within(trend).getAllByRole("row")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /Table 2/ }));
    expect(onOpenFile).toHaveBeenCalledWith("results/table2.csv");
    fireEvent.click(screen.getByRole("button", { name: /Paper/ }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://arxiv.org/abs/1706.03762");
    expect(screen.queryByRole("button", { name: /Plain/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open log" }));
    expect(onOpenFile).toHaveBeenLastCalledWith("results/log.md");
  });

  it("turns a button or a filled form into a prompt for the composer, never a direct action", async () => {
    const onPrompt = vi.fn();
    const view = render(<ChatPluginPanel {...props} panel={board} onPrompt={onPrompt} />);
    await screen.findByText("Shared by this project · Saved locally");
    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(onPrompt).toHaveBeenLastCalledWith("Refresh the board", true);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "large" } });
    fireEvent.change(screen.getByLabelText("Seeds"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ablation" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan it" }));
    expect(onPrompt).toHaveBeenLastCalledWith("Plan a large run with 3 seeds; ablation: yes.", false);
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
    // A value that looks like a placeholder is text, not expanded again.
    expect(fillPrompt("{{a}} {{b}} {{missing}}", { a: "{{b}}", b: "x" })).toBe("{{b}} x ");
    // Without a host to hand the click to, the controls are off.
    view.rerender(<ChatPluginPanel {...props} panel={board} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Refresh board" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Open log" }).disabled).toBe(true);
  });

  it("reloads when the agent writes this panel, and only this panel", async () => {
    render(<ChatPluginPanel {...props} panel={board} />);
    await screen.findByText("Shared by this project · Saved locally");
    expect(api.pluginsUiStateGet).toHaveBeenCalledTimes(1);
    const announce = (detail: api.PluginPanelChange) => act(async () => { window.dispatchEvent(new CustomEvent(api.PLUGIN_PANEL_CHANGED_EVENT, { detail })); });
    await announce({ projectPath: "F:/project", pluginName: "@local/board", panelId: "other" });
    await announce({ projectPath: "F:/elsewhere", pluginName: "@local/board", panelId: "board" });
    expect(api.pluginsUiStateGet).toHaveBeenCalledTimes(1);
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue(filled());
    // The backend reports the canonical spelling of the same folder.
    await announce({ projectPath: "\\\\?\\F:\\project", pluginName: "@local/board", panelId: "board" });
    expect(await screen.findByText("baseline")).toBeTruthy();
    expect(screen.queryByText("Loading panel…")).toBeNull();
  });

  it("gives a chart round axis ticks that cover the data", () => {
    expect(niceTicks(0, 99.3)).toEqual([0, 50, 100]);
    expect(niceTicks(0.65, 1.5)).toEqual([0.5, 1, 1.5]);
    expect(niceTicks(-3, 7)).toEqual([-5, 0, 5, 10]);
    expect(niceTicks(4, 4)).toEqual([3, 4, 5]);
    expect(niceTicks(0, 0.3)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});
