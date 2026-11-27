// @vitest-environment jsdom
// A `tool` button or form runs the package's own MCP tools directly: no
// prompt, no conversation. The view names only the widget and the form's
// values; the backend reads the calls from the reviewed declaration.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import ChatPluginPanel from "./ChatPluginPanel";

const native = vi.hoisted(() => ({ on: true }));
vi.mock("../api/transport", async (original) => ({ ...(await original<typeof import("../api/transport")>()), hasNativeBackend: () => native.on }));
vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()),
  pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(), pluginsUiRunTool: vi.fn(), pluginsUiCancelTool: vi.fn(),
}));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../chat/MarkdownContent", () => ({ default: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div> }));

const farm: api.ActiveUiPanel = {
  pluginName: "@lab/farm", packageDigest: "d1", id: "status", slot: "chat.sidebar", order: 0, scope: "project", title: "Farm",
  tools: [{ name: "farm_start" }, { name: "farm_status" }, { name: "farm_apply" }],
  widgets: [
    { id: "status", type: "markdown", title: "Service" },
    { id: "start", type: "button", label: "Start farm", action: { type: "tool", calls: [{ tool: "farm_start" }, { tool: "farm_status", into: "status" }] } },
    { id: "apply", type: "form", title: "Apply code", fields: [{ key: "code", label: "Code", input: "text" }, { key: "force", label: "Force", input: "checkbox" }],
      submit: { label: "Apply", action: { type: "tool", calls: [{ tool: "farm_apply", arguments: { code: "{{code}}", force: "{{force}}" } }] } } },
  ],
};
const props = { panel: farm, projectPath: "F:/farm", sessionId: "session-a", language: "en" as const, agentTodos: [] };

/** A promise the test settles when it wants. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.on = true;
  vi.mocked(api.pluginsUiStateGet).mockResolvedValue({ revision: 0, todoLists: {}, notes: {} });
  vi.mocked(api.pluginsUiCancelTool).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("tool buttons", () => {
  it("runs the tools directly, shows the run going, and what came back", async () => {
    const onPrompt = vi.fn();
    const run = deferred<api.PanelToolOutcome>();
    vi.mocked(api.pluginsUiRunTool).mockReturnValue(run.promise);
    render(<ChatPluginPanel {...props} onPrompt={onPrompt} />);
    const start = await screen.findByRole<HTMLButtonElement>("button", { name: "Start farm" });
    expect(start.title).toBe("Runs the plugin's tools directly, without a conversation: farm_start → farm_status");
    fireEvent.click(start);

    // Project data: the panel's shared copy, never the conversation's.
    expect(api.pluginsUiRunTool).toHaveBeenCalledWith("F:/farm", "@lab/farm", "status", "", expect.any(String), { from: "widget", widgetId: "start", values: undefined });
    expect(onPrompt).not.toHaveBeenCalled();
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
    expect(screen.getByText(/Running · 0:00/).getAttribute("role")).toBe("status");
    expect(start.disabled).toBe(true);
    // A second click while it runs starts nothing.
    fireEvent.click(start);
    expect(api.pluginsUiRunTool).toHaveBeenCalledTimes(1);

    // Output that went into a widget shows there; the rest under the button.
    await act(async () => run.resolve({ results: [
      { tool: "farm_start", text: "Started on port 3007", isError: false },
      { tool: "farm_status", text: "Up", isError: false, into: "status" },
    ], cancelled: false }));
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(screen.getByText("Started on port 3007")).toBeTruthy();
    expect(screen.queryByText("Up")).toBeNull();
  });

  it("stops a run on request and says a failed tool's own error", async () => {
    const run = deferred<api.PanelToolOutcome>();
    vi.mocked(api.pluginsUiRunTool).mockReturnValueOnce(run.promise);
    render(<ChatPluginPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start farm" }));
    const runId = vi.mocked(api.pluginsUiRunTool).mock.calls[0][4];
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.pluginsUiCancelTool).toHaveBeenCalledWith(runId);
    await act(async () => run.resolve({ results: [], cancelled: true }));
    expect(await screen.findByText("Stopped")).toBeTruthy();

    vi.mocked(api.pluginsUiRunTool).mockResolvedValueOnce({ results: [{ tool: "farm_start", text: "Task Scheduler refused the task", isError: true }], error: "farm_start reported an error", cancelled: false });
    fireEvent.click(screen.getByRole("button", { name: "Start farm" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Failed: Task Scheduler refused the task");
    // A failure of the run itself (the backend refused it) is said the same way.
    vi.mocked(api.pluginsUiRunTool).mockRejectedValueOnce(new Error("Plugin is disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Start farm" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Failed: Plugin is disabled"));
  });

  it("submits a tool form with each field as it is", async () => {
    vi.mocked(api.pluginsUiRunTool).mockResolvedValue({ results: [{ tool: "farm_apply", text: "Applied", isError: false }], cancelled: false });
    render(<ChatPluginPanel {...props} />);
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "  A1B2  " } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Force" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(api.pluginsUiRunTool).toHaveBeenCalledWith("F:/farm", "@lab/farm", "status", "", expect.any(String), { from: "widget", widgetId: "apply", values: { code: "A1B2", force: true } });
    expect(await screen.findByText("Applied")).toBeTruthy();
  });

  it("is off outside the desktop app, where nothing can run the tools", async () => {
    native.on = false;
    render(<ChatPluginPanel {...props} />);
    expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Start farm" })).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply" }).disabled).toBe(true);
  });
});
