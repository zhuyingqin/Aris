// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import ChatPluginPanel from "./ChatPluginPanel";

vi.mock("../api/plugins", () => ({ pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn() }));
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
});
