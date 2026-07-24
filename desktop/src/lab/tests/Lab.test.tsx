// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabCellOutputEvent, NotebookView, RunsLibrary } from "../labTypes";

const mocks = vi.hoisted(() => ({
  labCreateNotebook: vi.fn(),
  labEditCell: vi.fn(),
  labExecuteCell: vi.fn(),
  labExecuteFile: vi.fn(),
  labExportSweepManifest: vi.fn(),
  labInspectFileVars: vi.fn(),
  labInspectVars: vi.fn(),
  labInterruptFileKernel: vi.fn(),
  labInterruptKernel: vi.fn(),
  labListKernelspecs: vi.fn(),
  labListNotebooks: vi.fn(),
  labLoadNotebook: vi.fn(),
  labSaveNotebook: vi.fn(),
  labRunAll: vi.fn(),
  labRunSweep: vi.fn(),
  labSetKernelspec: vi.fn(),
  labShutdownFileKernel: vi.fn(),
  labShutdownKernel: vi.fn(),
  labStartFileKernel: vi.fn(),
  labStartKernel: vi.fn(),
  chatCancel: vi.fn(),
  chatPermissionGet: vi.fn(),
  chatPermissionRespond: vi.fn(),
  chatPermissionSet: vi.fn(),
  chatQuestionRespond: vi.fn(),
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
  onChatContextCompacted: vi.fn(),
  onChatContextWarning: vi.fn(),
  onChatPermissionRequest: vi.fn(),
  onChatPermissionResolved: vi.fn(),
  onChatReview: vi.fn(),
  onChatThinkingDelta: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolProgress: vi.fn(),
  onChatToolResult: vi.fn(),
  onLabCellOutput: vi.fn(),
  onLabFileOutput: vi.fn(),
  projectAdd: vi.fn(),
  projectsGet: vi.fn(),
  projectsReorder: vi.fn(),
  projectSetCurrent: vi.fn(),
  runsLoad: vi.fn(),
  stateDir: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  isTauri: () => true,
  labCreateNotebook: mocks.labCreateNotebook,
  labEditCell: mocks.labEditCell,
  labExecuteCell: mocks.labExecuteCell,
  labExecuteFile: mocks.labExecuteFile,
  labExportSweepManifest: mocks.labExportSweepManifest,
  labInspectFileVars: mocks.labInspectFileVars,
  labInspectVars: mocks.labInspectVars,
  labInterruptFileKernel: mocks.labInterruptFileKernel,
  labInterruptKernel: mocks.labInterruptKernel,
  labListKernelspecs: mocks.labListKernelspecs,
  labListNotebooks: mocks.labListNotebooks,
  labLoadNotebook: mocks.labLoadNotebook,
  labSaveNotebook: mocks.labSaveNotebook,
  labRunAll: mocks.labRunAll,
  labRunSweep: mocks.labRunSweep,
  labSetKernelspec: mocks.labSetKernelspec,
  labShutdownFileKernel: mocks.labShutdownFileKernel,
  labShutdownKernel: mocks.labShutdownKernel,
  labStartFileKernel: mocks.labStartFileKernel,
  labStartKernel: mocks.labStartKernel,
  chatCancel: mocks.chatCancel,
  chatPermissionGet: mocks.chatPermissionGet,
  chatPermissionRespond: mocks.chatPermissionRespond,
  chatPermissionSet: mocks.chatPermissionSet,
  chatQuestionRespond: mocks.chatQuestionRespond,
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
  onChatContextCompacted: mocks.onChatContextCompacted,
  onChatContextWarning: mocks.onChatContextWarning,
  onChatPermissionRequest: mocks.onChatPermissionRequest,
  onChatPermissionResolved: mocks.onChatPermissionResolved,
  onChatReview: mocks.onChatReview,
  onChatThinkingDelta: mocks.onChatThinkingDelta,
  onChatTool: mocks.onChatTool,
  onChatToolProgress: mocks.onChatToolProgress,
  onChatToolResult: mocks.onChatToolResult,
  onLabCellOutput: mocks.onLabCellOutput,
  onLabFileOutput: mocks.onLabFileOutput,
  projectAdd: mocks.projectAdd,
  projectsGet: mocks.projectsGet,
  projectsReorder: mocks.projectsReorder,
  projectSetCurrent: mocks.projectSetCurrent,
  runsLoad: mocks.runsLoad,
  stateDir: mocks.stateDir,
}));

import Lab from "../Lab";
import { useLabStore } from "../labStore";
import { useStore } from "../../store";

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
  // CodeMirror measures a hidden editor during mount. JSDOM exposes Range but
  // does not implement its layout methods, so return an empty rect list just
  // as a browser would for a detached/zero-size test surface.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    writable: true,
    value: vi.fn(() => []),
  });
  localStorage.removeItem("somniq-lab-side-w");
  localStorage.removeItem("somniq-lab-assistant-w");
  localStorage.removeItem("somniq-lab-assistant-sessions-v1");
  localStorage.removeItem("aris-lab-side-w");
  localStorage.removeItem("aris-lab-assistant-w");
  localStorage.removeItem("aris-lab-assistant-sessions-v1");
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
    kernelspecs: [],
    selectedKernel: null,
    runs: [],
    variables: [],
    activePath: null,
    view: null,
    reviewBaseline: null,
    assistantBusy: false,
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
  mocks.labSaveNotebook.mockReset().mockImplementation((path: string) => Promise.resolve(fixtureView(path)));
  mocks.onLabCellOutput.mockReset().mockResolvedValue(() => undefined);
  mocks.labCreateNotebook.mockReset().mockResolvedValue(fixtureView());
  mocks.labEditCell.mockReset().mockResolvedValue(fixtureView());
  mocks.labExecuteCell.mockReset().mockResolvedValue({ status: "ok", outputs: [], outline: [] });
  mocks.labExecuteFile.mockReset().mockResolvedValue({
    filePath: "src/main.py",
    status: "ok",
    executionCount: 1,
    outputs: [{ output_type: "stream", name: "stdout", text: "ran\n" }],
    kernelName: "python3",
  });
  mocks.labExportSweepManifest.mockReset().mockResolvedValue("");
  mocks.labInspectFileVars.mockReset().mockResolvedValue({ status: "ok", variables: [] });
  mocks.labInspectVars.mockReset().mockResolvedValue({ status: "ok", variables: [] });
  mocks.labInterruptFileKernel.mockReset().mockResolvedValue(undefined);
  mocks.labInterruptKernel.mockReset().mockResolvedValue(undefined);
  mocks.labRunAll.mockReset().mockResolvedValue({ status: "ok", ran: 1, cells: [], outline: [] });
  mocks.labRunSweep.mockReset().mockResolvedValue({ sweepId: "sweep-1", total: 0, runs: [] });
  mocks.labShutdownFileKernel.mockReset().mockResolvedValue(undefined);
  mocks.labShutdownKernel.mockReset().mockResolvedValue(undefined);
  mocks.labStartFileKernel.mockReset().mockResolvedValue({ id: "file:src/main.py", pid: 1, kernelName: "python3" });
  mocks.labStartKernel.mockReset().mockResolvedValue({});
  mocks.labListKernelspecs.mockReset().mockResolvedValue([
    { name: "python3", displayName: "Python 3", language: "python" },
    { name: "matlab", displayName: "MATLAB", language: "matlab" },
  ]);
  mocks.labSetKernelspec.mockReset().mockImplementation((path: string) => Promise.resolve(fixtureView(path)));
  mocks.chatCancel.mockReset().mockResolvedValue(undefined);
  mocks.chatPermissionGet.mockReset().mockResolvedValue({ mode: "workspace-write", label: "Accept edits", description: "" });
  mocks.chatPermissionRespond.mockReset().mockResolvedValue(undefined);
  mocks.chatQuestionRespond.mockReset().mockResolvedValue(undefined);
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
  mocks.onChatContextCompacted.mockReset().mockResolvedValue(unlisten);
  mocks.onChatContextWarning.mockReset().mockResolvedValue(unlisten);
  mocks.onChatPermissionRequest.mockReset().mockResolvedValue(unlisten);
  mocks.onChatPermissionResolved.mockReset().mockResolvedValue(unlisten);
  mocks.onChatReview.mockReset().mockResolvedValue(unlisten);
  mocks.onChatThinkingDelta.mockReset().mockResolvedValue(unlisten);
  mocks.onChatTool.mockReset().mockResolvedValue(unlisten);
  mocks.onChatToolProgress.mockReset().mockResolvedValue(unlisten);
  mocks.onChatToolResult.mockReset().mockResolvedValue(unlisten);
  mocks.onLabFileOutput.mockReset().mockResolvedValue(unlisten);
  mocks.projectAdd.mockReset();
  mocks.projectsGet.mockReset();
  mocks.projectsReorder.mockReset();
  mocks.projectSetCurrent.mockReset();
  mocks.stateDir.mockReset().mockResolvedValue("F:/state");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openNotebookFromPanel(container: HTMLElement, path = "notebooks/demo.ipynb") {
  fireEvent.click(screen.getByRole("tab", { name: "Notebook" }));
  expect(await screen.findByText(path)).toBeTruthy();
  const selector = container.querySelector<HTMLSelectElement>(".lab-panel-select");
  expect(selector).toBeTruthy();
  fireEvent.change(selector!, { target: { value: path } });
}

function firePanelPointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX: number; pointerId: number; button?: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX },
    pointerId: { value: init.pointerId },
  });
  fireEvent(target, event);
}

describe("Lab", () => {
  it("renders nbformat outputs after a notebook is reloaded", async () => {
    const { container } = render(<Lab />);
    expect(mocks.labLoadNotebook).not.toHaveBeenCalled();
    await openNotebookFromPanel(container);

    // The editor now syntax-highlights the source, so `42`/`hello` also exist as
    // code tokens — scope the output assertions to the rendered outputs region.
    expect(await screen.findByText("hello")).toBeTruthy();
    const outputs = container.querySelector(".lab-outputs");
    expect(outputs).toBeTruthy();
    expect(outputs?.textContent).toContain("hello");
    expect(outputs?.textContent).toContain("42");
    // CodeMirror's gutter also renders a hidden width-measurement "spacer"
    // sharing the same `.cm-gutterElement` class — filter it out to reach the
    // real, visible line-number elements.
    await waitFor(() => {
      const numbers = Array.from(container.querySelectorAll<HTMLElement>(".lab-editor .cm-gutterElement"))
        .filter((el) => el.style.visibility !== "hidden")
        .map((el) => el.textContent);
      expect(numbers).toContain("1");
    });
    await waitFor(() => expect(mocks.labLoadNotebook).toHaveBeenCalledWith("notebooks/demo.ipynb"));
  });

  it("resets notebooks without loading a notebook when the current project changes", async () => {
    mocks.labListNotebooks
      .mockReset()
      .mockResolvedValueOnce({ notebooks: ["project-a.ipynb"] })
      .mockResolvedValueOnce({ notebooks: ["project-b.ipynb"] });

    render(<Lab />);

    fireEvent.click(screen.getByRole("tab", { name: "Notebook" }));
    expect(await screen.findByText("project-a.ipynb")).toBeTruthy();
    expect(mocks.labLoadNotebook).not.toHaveBeenCalled();

    act(() => {
      useStore.setState({
        projects: [projectA, projectB],
        currentProject: projectB,
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: "Notebook" }));
    expect(await screen.findByText("project-b.ipynb")).toBeTruthy();
    expect(mocks.labLoadNotebook).not.toHaveBeenCalled();
    expect(screen.queryByText("project-a.ipynb")).toBeNull();
  });

  it("lists available kernels (Python + MATLAB) in the kernel picker", async () => {
    const { container } = render(<Lab />);
    fireEvent.click(screen.getByRole("tab", { name: "Runtime" }));

    const picker = await waitFor(() => {
      const select = container.querySelector(".lab-runtime-select") as HTMLSelectElement | null;
      expect(select).toBeTruthy();
      expect(select!.options.length).toBeGreaterThanOrEqual(2);
      return select!;
    });

    const labels = Array.from(picker.options).map((o) => o.textContent);
    expect(labels).toContain("Python 3");
    expect(labels).toContain("MATLAB");
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
    fireEvent.click(await screen.findByText("main.css"));

    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("web/site/main.css"));
    expect(container.querySelector(".lab-file-editor")).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector(".lab-file-editor-title")?.textContent).toContain("web/site/main.css"),
    );
    expect(screen.getByText("css")).toBeTruthy();
  });

  it("uses recognizable icons for common research workspace file types", async () => {
    mocks.fileListDir.mockResolvedValueOnce([
      { name: "paper.pdf", path: "papers/paper.pdf", isDir: false },
      { name: "main.tex", path: "papers/main.tex", isDir: false },
      { name: "thesis.cls", path: "thesis.cls", isDir: false },
      { name: "references.bib", path: "references.bib", isDir: false },
      { name: "knowledge.db", path: "knowledge.db", isDir: false },
      { name: "records.csv", path: "data/records.csv", isDir: false },
      { name: "library.json", path: "library.json", isDir: false },
      { name: "notes.md", path: "notes.md", isDir: false },
      { name: "main.log", path: "main.log", isDir: false },
      { name: "main.aux", path: "main.aux", isDir: false },
      { name: "figure.png", path: "figures/figure.png", isDir: false },
    ]);

    const { container } = render(<Lab />);
    await screen.findByText("paper.pdf");

    const kinds = Array.from(container.querySelectorAll<SVGElement>(".lab-explorer-tree [data-file-kind]"))
      .map((icon) => icon.dataset.fileKind);
    expect(kinds).toEqual(expect.arrayContaining([
      "pdf", "latex-source", "latex-template", "bibliography", "database", "data", "config", "markdown", "image", "latex-artifact",
    ]));
    expect(screen.queryByText("main.log")).toBeNull();
    expect(screen.queryByText("main.aux")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /LaTeX build files/ }));
    expect(await screen.findByText("main.log")).toBeTruthy();
    expect(screen.getByText("main.aux")).toBeTruthy();
  });

  it("opens a pending Code-page file after the initial project reset", async () => {
    useStore.setState({ pendingLabFilePath: "reports/result.md" });
    mocks.fileReadText.mockResolvedValueOnce({
      path: "reports/result.md",
      content: "# Result\n",
      bytes: 9,
    });

    const { container } = render(<Lab />);

    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("reports/result.md"));
    expect(container.querySelector(".lab-file-editor-title")?.textContent).toContain("reports/result.md");
    expect(useStore.getState().pendingLabFilePath).toBeNull();
  });

  it("shows AI file edits with highlight and keep or restore controls", async () => {
    const path = "web/site/main.css";
    const original = "body {\n  color: red;\n}";
    const changed = "body {\n  color: red;\n}\n.button {\n  color: blue;\n}";
    mocks.fileListDir.mockResolvedValueOnce([
      { name: "main.css", path, isDir: false },
    ]);
    mocks.fileReadText.mockResolvedValue({ path, content: original, bytes: original.length });

    const { container } = render(<Lab />);
    fireEvent.click(await screen.findByText("main.css"));

    await waitFor(() => {
      const view = window.__somniqEditors?.get("file");
      expect(view).toBeTruthy();
      expect(view!.state.doc.toString()).toBe(original);
    });

    mocks.fileReadText.mockResolvedValue({ path, content: changed, bytes: changed.length });

    await waitFor(() => expect(screen.getByText("检测到 AI 修改")).toBeTruthy(), { timeout: 3000 });
    expect(window.__somniqEditors?.get("file")?.state.doc.toString()).toBe(changed);
    expect(container.querySelector(".cm-diff-added")).toBeTruthy();
    expect(screen.getByLabelText("新增 3 行，移除 0 行")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    });
    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledWith(path, original));
    expect(screen.queryByText("检测到 AI 修改")).toBeNull();

    await waitFor(() => expect(screen.getByText("检测到 AI 修改")).toBeTruthy(), { timeout: 3000 });

    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(screen.queryByText("检测到 AI 修改")).toBeNull();
  });

  it("flags external (AI) notebook edits with cell highlights and review controls", async () => {
    const path = "notebooks/demo.ipynb";
    const baseCell = { cell_type: "code", id: "c1", source: "x = 1", execution_count: null, outputs: [] };
    const original: NotebookView = {
      notebookPath: path,
      notebook: { cells: [baseCell] },
      outline: [],
      running: false,
      kernelName: null,
    };
    const edited: NotebookView = {
      notebookPath: path,
      notebook: {
        cells: [
          { ...baseCell, source: "x = 2  # tweaked by AI" },
          { cell_type: "code", id: "c2", source: "y = 99", execution_count: null, outputs: [] },
        ],
      },
      outline: [],
      running: false,
      kernelName: null,
    };

    // open() loads the original; the disk poll then sees the AI-edited state.
    mocks.labLoadNotebook.mockReset().mockResolvedValueOnce(original).mockResolvedValue(edited);

    const { container } = render(<Lab />);
    await openNotebookFromPanel(container, path);

    // The 2s poll detects the disk change → review bar + highlighted cells.
    await waitFor(() => expect(screen.getByText("检测到 AI 修改")).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => {
      expect(container.querySelector(".lab-cell.cell-modified")).toBeTruthy();
      expect(container.querySelector(".lab-cell.cell-added")).toBeTruthy();
    });
    const modifiedCell = container.querySelector(".lab-cell.cell-modified");
    const addedCell = container.querySelector(".lab-cell.cell-added");
    expect(modifiedCell?.querySelector(".cm-diff-added")).toBeTruthy();
    expect(addedCell?.querySelector(".cm-diff-added")).toBeTruthy();

    // 保留 accepts the changes and clears the review highlighting.
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(screen.queryByText("检测到 AI 修改")).toBeNull());
    expect(container.querySelector(".lab-cell.cell-modified")).toBeNull();
  });

  it("runs Python files through the selected Lab kernel", async () => {
    mocks.fileListDir.mockResolvedValueOnce([
      { name: "main.py", path: "src/main.py", isDir: false },
    ]);
    mocks.fileReadText.mockResolvedValueOnce({
      path: "src/main.py",
      content: "print('hello')",
      bytes: 14,
    });

    const { container } = render(<Lab />);
    fireEvent.click(await screen.findByText("main.py"));

    const view = await waitFor(() => {
      const v = window.__somniqEditors?.get("file");
      expect(v).toBeTruthy();
      return v!;
    });
    const toolbarButtons = container.querySelectorAll(".lab-file-editor-actions .lab-file-tool");
    expect(toolbarButtons).toHaveLength(1);
    expect(toolbarButtons[0].getAttribute("aria-label")).toBe("Run Python File");

    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "x = 1\nprint(x)" } });
    });
    const runButton = container.querySelector<HTMLButtonElement>(".lab-run-file-btn");
    expect(runButton).toBeTruthy();
    fireEvent.click(runButton!);

    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledWith("src/main.py", "x = 1\nprint(x)"));
    await waitFor(() =>
      expect(mocks.labExecuteFile).toHaveBeenCalledWith("src/main.py", {
        kernel: "python3",
      }),
    );
    expect(await screen.findByText(/Run Python File: ok/i)).toBeTruthy();
    expect(screen.getByText("ran")).toBeTruthy();
  });

  it("opens Lab Assistant on the blank main state while keeping history available", async () => {
    localStorage.setItem("somniq-lab-assistant-sessions-v1", JSON.stringify([
      {
        id: "lab-chat-old",
        projectId: projectA.id,
        title: "Previous Lab question",
        turns: [
          {
            id: "turn-old-user",
            role: "user",
            blocks: [{ kind: "text", text: "Previous Lab question" }],
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ]));

    const { container } = render(<Lab />);
    await screen.findByPlaceholderText("Ask SomniQ to explain, inspect, or change code...");

    expect(screen.queryByText("Previous Lab question")).toBeNull();
    expect(container.querySelector(".lab-assistant-empty")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Lab chat history" }));
    const history = await screen.findByRole("menu", { name: "Lab chat history" });
    fireEvent.click(within(history).getByRole("menuitem", { name: /Previous Lab question/ }));

    expect(await screen.findByText("Previous Lab question")).toBeTruthy();
  });

  it("keeps Lab Assistant chats in local history", async () => {
    const { container } = render(<Lab />);
    const input = await screen.findByPlaceholderText("Ask SomniQ to explain, inspect, or change code...");
    fireEvent.change(input, { target: { value: "Explain my Lab history" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Explain my Lab history")).toBeTruthy();
    await waitFor(() => expect(mocks.chatSend).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "New Lab chat" }));
    expect(screen.queryByText("Explain my Lab history")).toBeNull();
    expect(container.querySelector(".lab-assistant-empty")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Lab chat history" }));
    const history = await screen.findByRole("menu", { name: "Lab chat history" });
    fireEvent.click(within(history).getByRole("menuitem", { name: /Explain my Lab history/ }));

    expect(await screen.findByText("Explain my Lab history")).toBeTruthy();
  });

  it("collapses and restores the side panel from the activity bar", async () => {
    const { container } = render(<Lab />);
    expect(container.querySelector(".lab-side")).toBeTruthy();

    // Clicking the active view collapses the panel; the activity bar stays put.
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(container.querySelector(".lab-side")).toBeNull();
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();

    // Clicking it again restores the panel.
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(container.querySelector(".lab-side")).toBeTruthy();
  });

  it("resizes the Lab side panels from their borders", async () => {
    const { container } = render(<Lab />);
    const root = container.querySelector<HTMLElement>(".lab");
    expect(root).toBeTruthy();

    const sideHandle = screen.getByLabelText("Resize Lab side panel");
    Object.defineProperty(sideHandle, "setPointerCapture", { value: vi.fn(), configurable: true });
    firePanelPointer(sideHandle, "pointerdown", { button: 0, clientX: 260, pointerId: 1 });
    firePanelPointer(sideHandle, "pointermove", { clientX: 310, pointerId: 1 });
    firePanelPointer(sideHandle, "pointerup", { clientX: 310, pointerId: 1 });
    expect(root!.style.getPropertyValue("--lab-side-w")).toBe("310px");
    expect(localStorage.getItem("somniq-lab-side-w")).toBe("310");

    const assistantHandle = screen.getByLabelText("Resize Lab Assistant");
    Object.defineProperty(assistantHandle, "setPointerCapture", { value: vi.fn(), configurable: true });
    firePanelPointer(assistantHandle, "pointerdown", { button: 0, clientX: 900, pointerId: 2 });
    firePanelPointer(assistantHandle, "pointermove", { clientX: 820, pointerId: 2 });
    firePanelPointer(assistantHandle, "pointerup", { clientX: 820, pointerId: 2 });
    expect(root!.style.getPropertyValue("--lab-assistant-w")).toBe("460px");
    expect(localStorage.getItem("somniq-lab-assistant-w")).toBe("460");
  });

  it("closes other editor tabs from the tab context menu", async () => {
    mocks.fileListDir.mockResolvedValue([
      { name: "a.py", path: "src/a.py", isDir: false },
      { name: "b.py", path: "src/b.py", isDir: false },
    ]);
    mocks.fileReadText.mockImplementation((p: string) =>
      Promise.resolve({ path: p, content: "x = 1", bytes: 5 }),
    );

    const { container } = render(<Lab />);
    // Double-click pins each tab; a single click would only preview it (see
    // the preview-tab tests below), which this test isn't exercising.
    fireEvent.doubleClick(await screen.findByText("a.py"));
    fireEvent.doubleClick(await screen.findByText("b.py"));
    await waitFor(() => expect(container.querySelectorAll(".lab-editor-tab").length).toBe(2));

    const tabs = container.querySelectorAll(".lab-editor-tab");
    fireEvent.contextMenu(tabs[1]);

    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Close others" }));

    await waitFor(() => expect(container.querySelectorAll(".lab-editor-tab").length).toBe(1));
    expect(container.querySelector(".lab-editor-tab-label")?.textContent).toBe("b.py");
  });

  it("opens a right-click context menu on an explorer row instead of always-visible hover icons", async () => {
    mocks.fileListDir.mockResolvedValue([
      { name: "a.py", path: "src/a.py", isDir: false },
    ]);

    const { container } = render(<Lab />);
    const explorer = () => within(container.querySelector(".lab-explorer-tree") as HTMLElement);
    const row = (await explorer().findByText("a.py")).closest(".lab-explorer-row") as HTMLElement;

    // No per-row action buttons render up front (they only exist via the
    // context menu now).
    expect(row.querySelector(".lab-explorer-row-actions")).toBeNull();

    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Attach to assistant",
      "Rename / Move",
      "Delete",
    ]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Attach to assistant" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(await screen.findByLabelText("Remove a.py")).toBeTruthy();
  });

  it("single-clicking a file opens a replaceable preview tab instead of pinning it", async () => {
    mocks.fileListDir.mockResolvedValue([
      { name: "a.py", path: "src/a.py", isDir: false },
      { name: "b.py", path: "src/b.py", isDir: false },
    ]);
    mocks.fileReadText.mockImplementation((p: string) =>
      Promise.resolve({ path: p, content: "x = 1", bytes: 5 }),
    );

    const { container } = render(<Lab />);
    // Scoped to the explorer tree: once a.py is open, its basename also shows
    // up in the file-editor title, which would make an unscoped findByText
    // ambiguous.
    const explorer = () => within(container.querySelector(".lab-explorer-tree") as HTMLElement);
    fireEvent.click(await explorer().findByText("a.py"));

    await waitFor(() => expect(container.querySelectorAll(".lab-editor-tab").length).toBe(1));
    expect(container.querySelector(".lab-editor-tab.preview .lab-editor-tab-label")?.textContent).toBe("a.py");

    // Single-clicking a second file replaces the preview tab rather than
    // adding a new one.
    fireEvent.click(await explorer().findByText("b.py"));

    await waitFor(() => expect(container.querySelector(".lab-file-editor-title")?.textContent).toContain("src/b.py"));
    expect(container.querySelectorAll(".lab-editor-tab").length).toBe(1);
    expect(container.querySelector(".lab-editor-tab.preview .lab-editor-tab-label")?.textContent).toBe("b.py");
  });

  it("double-clicking a file promotes its preview tab to a permanent one", async () => {
    mocks.fileListDir.mockResolvedValue([
      { name: "a.py", path: "src/a.py", isDir: false },
      { name: "b.py", path: "src/b.py", isDir: false },
    ]);
    mocks.fileReadText.mockImplementation((p: string) =>
      Promise.resolve({ path: p, content: "x = 1", bytes: 5 }),
    );

    const { container } = render(<Lab />);
    const explorer = () => within(container.querySelector(".lab-explorer-tree") as HTMLElement);
    fireEvent.click(await explorer().findByText("a.py"));
    await waitFor(() => expect(container.querySelector(".lab-editor-tab.preview")).toBeTruthy());

    fireEvent.doubleClick(await explorer().findByText("a.py"));
    await waitFor(() => expect(container.querySelector(".lab-editor-tab.preview")).toBeNull());

    // The pinned a.py tab now survives opening a second file via single click.
    fireEvent.click(await explorer().findByText("b.py"));
    await waitFor(() => expect(container.querySelectorAll(".lab-editor-tab").length).toBe(2));
    const labels = Array.from(container.querySelectorAll(".lab-editor-tab-label")).map((el) => el.textContent);
    expect(labels).toEqual(["a.py", "b.py"]);
  });

  it("marks the notebook tab dirty on an edit and clears it on Ctrl+S", async () => {
    const { container } = render(<Lab />);
    await openNotebookFromPanel(container);
    await waitFor(() => expect(window.__somniqEditors?.get("0")).toBeTruthy());

    const editor = window.__somniqEditors!.get("0")!;
    act(() => {
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nx = 1" } });
    });

    const notebookTab = () => container.querySelector(".lab-editor-tab");
    await waitFor(() => expect(notebookTab()?.classList.contains("dirty")).toBe(true));

    mocks.labEditCell.mockClear();
    fireEvent.keyDown(container.querySelector('[data-cell="0"]')!, { key: "s", ctrlKey: true });

    await waitFor(() =>
      expect(mocks.labEditCell).toHaveBeenCalledWith(
        "notebooks/demo.ipynb",
        "replace",
        expect.objectContaining({ cellIndex: 0 }),
      ),
    );
    await waitFor(() => expect(notebookTab()?.classList.contains("dirty")).toBe(false));
  });

  it("marks a file tab dirty while it has unsaved edits", async () => {
    mocks.fileListDir.mockResolvedValue([{ name: "a.py", path: "src/a.py", isDir: false }]);
    mocks.fileReadText.mockImplementation((p: string) =>
      Promise.resolve({ path: p, content: "x = 1", bytes: 5 }),
    );

    const { container } = render(<Lab />);
    const explorer = () => within(container.querySelector(".lab-explorer-tree") as HTMLElement);
    fireEvent.click(await explorer().findByText("a.py"));
    await waitFor(() => expect(window.__somniqEditors?.get("file")).toBeTruthy());

    const fileTab = () => container.querySelector(".lab-editor-tab");
    expect(fileTab()?.classList.contains("dirty")).toBe(false);

    const editor = window.__somniqEditors!.get("file")!;
    act(() => {
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\ny = 2" } });
    });
    await waitFor(() => expect(fileTab()?.classList.contains("dirty")).toBe(true));
  });

  it("empties a cell's streamed outputs on a clear_output signal", async () => {
    let onCellOutput: ((event: LabCellOutputEvent) => void) | null = null;
    mocks.onLabCellOutput.mockReset().mockImplementation((handler: (event: LabCellOutputEvent) => void) => {
      onCellOutput = handler;
      return Promise.resolve(() => undefined);
    });

    const { container } = render(<Lab />);
    await openNotebookFromPanel(container);
    await waitFor(() => expect(container.querySelector(".lab-outputs")).toBeTruthy());
    await waitFor(() => expect(onCellOutput).toBeTruthy());

    const emit = (output: LabCellOutputEvent["output"]) =>
      act(() => onCellOutput!({ notebookPath: "notebooks/demo.ipynb", cellIndex: 0, output }));

    emit({ type: "stream", name: "stdout", text: "progress 1\n" });
    await waitFor(() => expect(container.querySelector(".lab-outputs")?.textContent).toContain("progress 1"));

    // A clear signal drops the shown outputs entirely (the block unmounts once
    // the cell has no outputs), rather than appending another line.
    emit({ type: "clear" });
    await waitFor(() => expect(container.querySelector(".lab-outputs")).toBeNull());
  });
});
