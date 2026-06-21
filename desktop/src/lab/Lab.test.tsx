// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookView, RunsLibrary } from "./labTypes";

const mocks = vi.hoisted(() => ({
  labCreateNotebook: vi.fn(),
  labEditCell: vi.fn(),
  labExecuteCell: vi.fn(),
  labExportSweepManifest: vi.fn(),
  labInspectVars: vi.fn(),
  labInterruptKernel: vi.fn(),
  labListNotebooks: vi.fn(),
  labLoadNotebook: vi.fn(),
  labRunAll: vi.fn(),
  labRunSweep: vi.fn(),
  labShutdownKernel: vi.fn(),
  labStartKernel: vi.fn(),
  chatCancel: vi.fn(),
  chatPermissionGet: vi.fn(),
  chatPermissionRespond: vi.fn(),
  chatPermissionSet: vi.fn(),
  chatSend: vi.fn(),
  chatSetContext: vi.fn(),
  chatStatus: vi.fn(),
  fileListDir: vi.fn(),
  fileOpen: vi.fn(),
  fileRead: vi.fn(),
  fileReadText: vi.fn(),
  fileSearch: vi.fn(),
  fileWriteText: vi.fn(),
  onChatDelta: vi.fn(),
  onChatDone: vi.fn(),
  onChatError: vi.fn(),
  onChatPermissionRequest: vi.fn(),
  onChatPermissionResolved: vi.fn(),
  onChatThinkingDelta: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolResult: vi.fn(),
  onLabCellOutput: vi.fn(),
  projectAdd: vi.fn(),
  projectsGet: vi.fn(),
  projectsReorder: vi.fn(),
  projectSetCurrent: vi.fn(),
  runsLoad: vi.fn(),
  stateDir: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  labCreateNotebook: mocks.labCreateNotebook,
  labEditCell: mocks.labEditCell,
  labExecuteCell: mocks.labExecuteCell,
  labExportSweepManifest: mocks.labExportSweepManifest,
  labInspectVars: mocks.labInspectVars,
  labInterruptKernel: mocks.labInterruptKernel,
  labListNotebooks: mocks.labListNotebooks,
  labLoadNotebook: mocks.labLoadNotebook,
  labRunAll: mocks.labRunAll,
  labRunSweep: mocks.labRunSweep,
  labShutdownKernel: mocks.labShutdownKernel,
  labStartKernel: mocks.labStartKernel,
  chatCancel: mocks.chatCancel,
  chatPermissionGet: mocks.chatPermissionGet,
  chatPermissionRespond: mocks.chatPermissionRespond,
  chatPermissionSet: mocks.chatPermissionSet,
  chatSend: mocks.chatSend,
  chatSetContext: mocks.chatSetContext,
  chatStatus: mocks.chatStatus,
  fileListDir: mocks.fileListDir,
  fileOpen: mocks.fileOpen,
  fileRead: mocks.fileRead,
  fileReadText: mocks.fileReadText,
  fileSearch: mocks.fileSearch,
  fileWriteText: mocks.fileWriteText,
  onChatDelta: mocks.onChatDelta,
  onChatDone: mocks.onChatDone,
  onChatError: mocks.onChatError,
  onChatPermissionRequest: mocks.onChatPermissionRequest,
  onChatPermissionResolved: mocks.onChatPermissionResolved,
  onChatThinkingDelta: mocks.onChatThinkingDelta,
  onChatTool: mocks.onChatTool,
  onChatToolResult: mocks.onChatToolResult,
  onLabCellOutput: mocks.onLabCellOutput,
  projectAdd: mocks.projectAdd,
  projectsGet: mocks.projectsGet,
  projectsReorder: mocks.projectsReorder,
  projectSetCurrent: mocks.projectSetCurrent,
  runsLoad: mocks.runsLoad,
  stateDir: mocks.stateDir,
}));

import Lab from "./Lab";
import { useLabStore } from "./labStore";
import { useStore } from "../store";

const projectA = {
  id: "project-a",
  name: "Project A",
  path: "F:/ProjectA",
  addedAt: 1,
  lastOpenedAt: 1,
};

const projectB = {
  id: "project-b",
  name: "Project B",
  path: "F:/ProjectB",
  addedAt: 2,
  lastOpenedAt: 2,
};

const fixtureView = (notebookPath = "F:/Agent/Aris/notebooks/demo.ipynb"): NotebookView => ({
  notebookPath,
  notebook: {
    cells: [
      {
        cell_type: "code",
        source: "print('hello')\n42",
        execution_count: 1,
        outputs: [
          { output_type: "stream", name: "stdout", text: "hello\n" },
          {
            output_type: "execute_result",
            execution_count: 1,
            data: { "text/plain": "42" },
            metadata: {},
          },
        ],
      },
    ],
  },
  outline: [],
  running: false,
  kernelName: null,
});

beforeEach(() => {
  useStore.setState({
    tab: "lab",
    projects: [projectA],
    currentProject: projectA,
    projectBusy: false,
    error: null,
  });
  useLabStore.setState({
    currentProjectId: null,
    notebooks: [],
    runs: [],
    variables: [],
    activePath: null,
    view: null,
    busy: false,
    variablesBusy: false,
    runningCell: null,
    runningAll: false,
    sweepBusy: false,
    sweepResult: null,
    sweepManifest: null,
    error: null,
  });
  mocks.labListNotebooks.mockReset().mockResolvedValue({ notebooks: ["notebooks/demo.ipynb"] });
  mocks.runsLoad.mockReset().mockResolvedValue({ version: 1, runs: [] } satisfies RunsLibrary);
  mocks.labLoadNotebook.mockReset().mockImplementation((path: string) => Promise.resolve(fixtureView(path)));
  mocks.onLabCellOutput.mockReset().mockResolvedValue(() => undefined);
  mocks.labCreateNotebook.mockReset().mockResolvedValue(fixtureView());
  mocks.labEditCell.mockReset().mockResolvedValue(fixtureView());
  mocks.labExecuteCell.mockReset().mockResolvedValue({ status: "ok", outputs: [], outline: [] });
  mocks.labExportSweepManifest.mockReset().mockResolvedValue("");
  mocks.labInspectVars.mockReset().mockResolvedValue({ status: "ok", variables: [] });
  mocks.labInterruptKernel.mockReset().mockResolvedValue(undefined);
  mocks.labRunAll.mockReset().mockResolvedValue({ status: "ok", ran: 1, cells: [], outline: [] });
  mocks.labRunSweep.mockReset().mockResolvedValue({ sweepId: "sweep-1", total: 0, runs: [] });
  mocks.labShutdownKernel.mockReset().mockResolvedValue(undefined);
  mocks.labStartKernel.mockReset().mockResolvedValue({});
  mocks.chatCancel.mockReset().mockResolvedValue(undefined);
  mocks.chatPermissionGet.mockReset().mockResolvedValue({ mode: "workspace-write", label: "Accept edits", description: "" });
  mocks.chatPermissionRespond.mockReset().mockResolvedValue(undefined);
  mocks.chatPermissionSet.mockReset().mockResolvedValue({ mode: "workspace-write", label: "Accept edits", description: "" });
  mocks.chatSend.mockReset().mockResolvedValue("ok");
  mocks.chatSetContext.mockReset().mockResolvedValue(undefined);
  mocks.chatStatus.mockReset().mockResolvedValue({ ready: true, model: "test-model", provider: "test" });
  mocks.fileListDir.mockReset().mockResolvedValue([]);
  mocks.fileOpen.mockReset().mockResolvedValue(undefined);
  mocks.fileRead.mockReset().mockResolvedValue("");
  mocks.fileReadText.mockReset().mockResolvedValue({ path: "src/main.css", content: "body { color: red; }", bytes: 20 });
  mocks.fileSearch.mockReset().mockResolvedValue([]);
  mocks.fileWriteText.mockReset().mockImplementation((path: string, content: string) => Promise.resolve({ path, content, bytes: content.length }));
  const unlisten = () => undefined;
  mocks.onChatDelta.mockReset().mockResolvedValue(unlisten);
  mocks.onChatDone.mockReset().mockResolvedValue(unlisten);
  mocks.onChatError.mockReset().mockResolvedValue(unlisten);
  mocks.onChatPermissionRequest.mockReset().mockResolvedValue(unlisten);
  mocks.onChatPermissionResolved.mockReset().mockResolvedValue(unlisten);
  mocks.onChatThinkingDelta.mockReset().mockResolvedValue(unlisten);
  mocks.onChatTool.mockReset().mockResolvedValue(unlisten);
  mocks.onChatToolResult.mockReset().mockResolvedValue(unlisten);
  mocks.projectAdd.mockReset();
  mocks.projectsGet.mockReset();
  mocks.projectsReorder.mockReset();
  mocks.projectSetCurrent.mockReset();
  mocks.stateDir.mockReset().mockResolvedValue("F:/state");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Lab", () => {
  it("renders nbformat outputs after a notebook is reloaded", async () => {
    const { container } = render(<Lab />);
    expect(await screen.findByText("notebooks/demo.ipynb")).toBeTruthy();
    expect(mocks.labLoadNotebook).not.toHaveBeenCalled();
    const selector = container.querySelector<HTMLSelectElement>(".lab-select");
    expect(selector).toBeTruthy();
    fireEvent.change(selector!, { target: { value: "notebooks/demo.ipynb" } });

    // The editor now syntax-highlights the source, so `42`/`hello` also exist as
    // code tokens — scope the output assertions to the rendered outputs region.
    expect(await screen.findByText("hello")).toBeTruthy();
    const outputs = container.querySelector(".lab-outputs");
    expect(outputs).toBeTruthy();
    expect(outputs?.textContent).toContain("hello");
    expect(outputs?.textContent).toContain("42");
    await waitFor(() => expect(mocks.labLoadNotebook).toHaveBeenCalledWith("notebooks/demo.ipynb"));
  });

  it("resets notebooks without loading a notebook when the current project changes", async () => {
    mocks.labListNotebooks
      .mockReset()
      .mockResolvedValueOnce({ notebooks: ["project-a.ipynb"] })
      .mockResolvedValueOnce({ notebooks: ["project-b.ipynb"] });

    render(<Lab />);

    expect(await screen.findByText("project-a.ipynb")).toBeTruthy();
    expect(mocks.labLoadNotebook).not.toHaveBeenCalled();

    act(() => {
      useStore.setState({
        projects: [projectA, projectB],
        currentProject: projectB,
      });
    });

    expect(await screen.findByText("project-b.ipynb")).toBeTruthy();
    expect(mocks.labLoadNotebook).not.toHaveBeenCalled();
    expect(screen.queryByText("project-a.ipynb")).toBeNull();
  });

  it("opens regular files in the main Lab editor from Files", async () => {
    mocks.fileListDir.mockResolvedValueOnce([
      { name: "notebooks", path: "notebooks", isDir: true },
      { name: "main.css", path: "web/site/main.css", isDir: false },
    ]);
    mocks.fileReadText.mockResolvedValueOnce({
      path: "web/site/main.css",
      content: "body { color: red; }",
      bytes: 20,
    });

    const { container } = render(<Lab />);
    expect(await screen.findByText("notebooks/demo.ipynb")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(await screen.findByText("main.css"));

    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("web/site/main.css"));
    expect(container.querySelector(".lab-file-editor")).toBeTruthy();
    expect(await screen.findByText("web/site/main.css")).toBeTruthy();
    expect(screen.getByText("css")).toBeTruthy();
  });
});
