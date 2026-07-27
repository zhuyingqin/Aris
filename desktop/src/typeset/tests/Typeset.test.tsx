// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { highlightingFor } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Typeset from "../Typeset";
import { resetLiteratureStore, useLiteratureStore } from "../../literature/literatureStore";
import { useStore } from "../../store";

const mocks = vi.hoisted(() => ({
  configSet: vi.fn(),
  fileCreateText: vi.fn(),
  fileDelete: vi.fn(),
  fileDuplicate: vi.fn(),
  fileListDir: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  fileReadText: vi.fn(),
  fileRename: vi.fn(),
  fileReveal: vi.fn(),
  fileSearch: vi.fn(),
  fileWriteText: vi.fn(),
  latexCompile: vi.fn(),
  latexCompileCancel: vi.fn(),
  latexForwardSearch: vi.fn(),
  literatureApplyDelta: vi.fn(),
  literatureExportBibliography: vi.fn(),
  literatureLoad: vi.fn(),
  localEnvironmentCheck: vi.fn(),
  onLatexCompileProgress: vi.fn(),
  projectAdd: vi.fn(),
  projectsGet: vi.fn(),
  projectsReorder: vi.fn(),
  projectSetCurrent: vi.fn(),
  stateDir: vi.fn(),
  typesetListDocuments: vi.fn(),
}));

const pdfMocks = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getTextContent = vi.fn(() => Promise.resolve({
    items: [
      { str: "Body text", transform: [10, 0, 0, 10, 24, 64], width: 48, height: 10 },
    ],
  }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 240 * scale,
      height: 120 * scale,
      transform: [scale, 0, 0, -scale, 0, 120 * scale],
    }),
    getTextContent,
    render,
  };
  const document = {
    numPages: 1,
    getPage: vi.fn(() => Promise.resolve(page)),
    destroy: vi.fn(),
  };
  return {
    document,
    getDocument: vi.fn(() => ({ promise: Promise.resolve(document) })),
    getTextContent,
    page,
    render,
  };
});

vi.mock("../../api/tauri", () => ({
  configSet: mocks.configSet,
  fileCreateText: mocks.fileCreateText,
  fileDelete: mocks.fileDelete,
  fileDuplicate: mocks.fileDuplicate,
  fileListDir: mocks.fileListDir,
  fileOpen: mocks.fileOpen,
  fileReadBytes: mocks.fileReadBytes,
  fileReadText: mocks.fileReadText,
  fileRename: mocks.fileRename,
  fileReveal: mocks.fileReveal,
  fileSearch: mocks.fileSearch,
  fileWriteText: mocks.fileWriteText,
  isTauri: () => true,
  latexCompile: mocks.latexCompile,
  latexCompileCancel: mocks.latexCompileCancel,
  latexForwardSearch: mocks.latexForwardSearch,
  literatureApplyDelta: mocks.literatureApplyDelta,
  literatureExportBibliography: mocks.literatureExportBibliography,
  literatureLoad: mocks.literatureLoad,
  localEnvironmentCheck: mocks.localEnvironmentCheck,
  onLatexCompileProgress: mocks.onLatexCompileProgress,
  projectAdd: mocks.projectAdd,
  projectsGet: mocks.projectsGet,
  projectsReorder: mocks.projectsReorder,
  projectSetCurrent: mocks.projectSetCurrent,
  stateDir: mocks.stateDir,
  typesetListDocuments: mocks.typesetListDocuments,
}));

vi.mock("../../api/labPreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/labPreview")>();
  return {
    ...actual,
    isTypesetPreviewMode: () => false,
  };
});

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfMocks.getDocument,
}));

const project = {
  id: "project-a",
  name: "Project A",
  path: "F:/ProjectA",
  addedAt: 1,
  lastOpenedAt: 1,
};

class MockPointerEvent extends MouseEvent {
  pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
  }
}

beforeEach(() => {
  resetLiteratureStore();
  window.localStorage.removeItem("somniq-typeset-preview");
  window.localStorage.removeItem("somniq-lab-preview");
  window.localStorage.removeItem("aris-lab-preview");
  window.localStorage.removeItem("somniq-typeset-compile-error-handling:project-a");
  if (!window.PointerEvent) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      writable: true,
      value: MockPointerEvent,
    });
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({})),
  });
  // jsdom has no layout engine, so `Range.getClientRects` is unimplemented —
  // CodeMirror's async measurement pass (scheduled via requestAnimationFrame
  // after a dispatch with `scrollIntoView: true`) calls it and throws an
  // uncaught exception outside any test's own await chain otherwise.
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      writable: true,
      value: vi.fn(() => []),
    });
  }
  pdfMocks.render.mockReset().mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
  pdfMocks.document.numPages = 1;
  pdfMocks.getTextContent.mockReset().mockResolvedValue({
    items: [
      { str: "Body text", transform: [10, 0, 0, 10, 24, 64], width: 48, height: 10 },
    ],
  });
  pdfMocks.document.getPage.mockReset().mockResolvedValue(pdfMocks.page);
  pdfMocks.document.destroy.mockReset();
  pdfMocks.getDocument.mockReset().mockReturnValue({ promise: Promise.resolve(pdfMocks.document) });
  useStore.setState({
    tab: "typeset",
    language: "en",
    pendingChatInput: null,
    pendingTypesetFilePath: null,
    projects: [project],
    currentProject: project,
    projectBusy: false,
    typesetDirty: false,
    error: null,
  });
  mocks.fileCreateText.mockReset().mockResolvedValue({ path: "papers/main.tex", content: "", bytes: 0 });
  mocks.literatureLoad.mockReset().mockResolvedValue({
    version: 1,
    papers: [],
    searches: [],
    collections: [],
    reviewTasks: [],
    screenRuns: [],
  });
  mocks.literatureExportBibliography.mockReset().mockResolvedValue({ content: "", exported: 0 });
  mocks.literatureApplyDelta.mockReset().mockResolvedValue({});
  mocks.fileDelete.mockReset().mockResolvedValue(undefined);
  mocks.fileDuplicate.mockReset().mockResolvedValue({ name: "notes copy.md", path: "sections/notes copy.md", isDir: false });
  mocks.fileOpen.mockReset().mockResolvedValue(undefined);
  mocks.fileReadBytes.mockReset().mockResolvedValue(new ArrayBuffer(0));
  mocks.fileReadText.mockReset().mockResolvedValue({
    path: "sections/local.tex",
    content: "\\documentclass{article}\n\\begin{document}\n\\section{Local}\nBody text\n\\end{document}",
    bytes: 80,
  });
  mocks.fileRename.mockReset().mockImplementation((_path: string, newPath: string) => Promise.resolve({
    name: newPath.split("/").pop() ?? newPath,
    path: newPath,
    isDir: false,
  }));
  mocks.fileReveal.mockReset().mockResolvedValue(undefined);
  mocks.typesetListDocuments.mockReset().mockResolvedValue([
    { path: "sections/local.tex", title: "local.tex", kind: "article", modifiedEpochMs: 3, compileState: "missing" },
    { path: "paper.tex", title: "paper.tex", kind: "article", modifiedEpochMs: 2, compileState: "missing" },
  ]);
  mocks.latexCompileCancel.mockReset().mockResolvedValue(undefined);
  mocks.fileWriteText.mockReset().mockImplementation((path: string, content: string) => Promise.resolve({ path, content, bytes: content.length }));
  mocks.latexCompile.mockReset().mockResolvedValue({ success: true, outputPath: "paper.pdf" });
  mocks.onLatexCompileProgress.mockReset().mockResolvedValue(() => undefined);
  mocks.latexForwardSearch.mockReset().mockResolvedValue({
    found: true,
    locations: [{ page: 1, pointX: 50, pointY: 60, boxLeft: 40, boxTop: 55, boxWidth: 100, boxHeight: 12 }],
    stderr: "",
  });
  mocks.localEnvironmentCheck.mockReset().mockResolvedValue({
    id: "latex",
    label: "LaTeX",
    category: "Typesetting",
    status: "ready",
    available: true,
    version: "TeX Live",
    path: "latexmk",
    message: "Available",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Typeset start page", () => {
  function mockProjectFiles() {
    mocks.typesetListDocuments.mockResolvedValue([
      { path: "sections/local.tex", title: "local.tex", kind: "article", modifiedEpochMs: 300, compileState: "fresh" },
      { path: "drafts/other.tex", title: "other.tex", kind: "report", modifiedEpochMs: 200, compileState: "stale" },
      { path: "paper.tex", title: "paper.tex", kind: "article", modifiedEpochMs: 100, compileState: "missing" },
    ]);
    mocks.fileSearch.mockImplementation((pattern: string) => {
      if (pattern.endsWith("*.tex")) return Promise.resolve(["sections/local.tex", "drafts/other.tex", "paper.tex"]);
      return Promise.resolve([]);
    });
    mocks.fileListDir.mockImplementation((path: string | null) => {
      if (path === "sections") {
        return Promise.resolve([
          { name: "local.tex", path: "sections/local.tex", isDir: false },
          { name: "notes.md", path: "sections/notes.md", isDir: false },
          { name: "nested", path: "sections/nested", isDir: true },
        ]);
      }
      return Promise.resolve([
        { name: "sections", path: "sections", isDir: true },
        { name: "drafts", path: "drafts", isDir: true },
        { name: "paper.tex", path: "paper.tex", isDir: false },
      ]);
    });
  }

  async function waitForSourceOpen(container: HTMLElement, path: string, label = path.split(/[\\/]/).pop() ?? path) {
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith(path));
    await waitFor(() => expect(container.querySelector(".typeset-visual-filebar strong")?.textContent).toBe(label));
  }

  // Code mode is now a CodeMirror instance (see desktop/src/lab/CodeEditor.tsx),
  // registered under this id (`dataEditor="typeset-code"` in Typeset.tsx) in the
  // DEV-only test registry — the same pattern `window.__typesetView` already
  // uses for Visual mode, since there's no other way to reach a CodeMirror view
  // mounted deep inside the component tree from a black-box render test.
  function typesetCodeView() {
    return window.__somniqEditors?.get("typeset-code");
  }

  async function recompileOpenSource() {
    const button = await screen.findByRole("button", { name: "Recompile" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
  }

  it("consumes a pending LaTeX source opened from Chat", async () => {
    useStore.setState({ pendingTypesetFilePath: "papers/chat-draft.tex" });
    mocks.fileReadText.mockResolvedValueOnce({
      path: "papers/chat-draft.tex",
      content: "\\documentclass{article}\\n\\begin{document}Chat draft\\n\\end{document}",
      bytes: 60,
    });

    render(<Typeset />);

    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("papers/chat-draft.tex"));
    expect(useStore.getState().pendingTypesetFilePath).toBeNull();
    expect(await screen.findByRole("button", { name: "Home" })).toBeTruthy();
  });

  it("opens a pending PDF directly in the side preview", async () => {
    useStore.setState({ pendingTypesetFilePath: "exports/chat-result.pdf" });
    const { container } = render(<Typeset />);

    await waitFor(() => expect(mocks.fileReadBytes).toHaveBeenCalledWith("exports/chat-result.pdf"));
    expect(useStore.getState().pendingTypesetFilePath).toBeNull();
    expect(screen.getByLabelText("PDF preview")).toBeTruthy();
    expect(screen.getByText("chat-result.pdf")).toBeTruthy();
    expect(container.querySelector(".typeset-preview-stack")).toBeTruthy();
  });

  it("shows root documents and filters the document library", async () => {
    mockProjectFiles();

    render(<Typeset />);

    expect(await screen.findByText("other.tex")).toBeTruthy();
    expect(screen.getByText("paper.tex")).toBeTruthy();
    expect(screen.getByText("local.tex")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reports" }));
    expect(await screen.findByText("other.tex")).toBeTruthy();
    expect(screen.queryByText("paper.tex")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search by title or path"), { target: { value: "local" } });
    expect(screen.queryByText("other.tex")).toBeNull();
    expect(screen.queryByText("local.tex")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All documents" }));
    expect(await screen.findByText("local.tex")).toBeTruthy();
  });

  it("follows the global Chinese language setting", async () => {
    mockProjectFiles();
    useStore.setState({ language: "cn" });

    render(<Typeset />);

    expect(await screen.findByRole("heading", { name: "全部文档" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建 LaTeX 文档" })).toBeTruthy();
    expect(screen.getByPlaceholderText("按标题或路径搜索")).toBeTruthy();
    expect(screen.getByText("已编译")).toBeTruthy();
    expect(screen.getAllByText("需要编译").length).toBeGreaterThan(0);
  });

  it("hands a missing LaTeX toolchain to Chat for installation", async () => {
    mockProjectFiles();
    mocks.localEnvironmentCheck.mockResolvedValue({
      id: "latex",
      label: "LaTeX",
      category: "Typesetting",
      status: "missing",
      available: false,
      version: null,
      path: null,
      message: "Not installed",
    });

    render(<Typeset />);

    fireEvent.click(await screen.findByRole("button", { name: "Install with Chat" }));

    expect(useStore.getState().tab).toBe("chat");
    expect(useStore.getState().pendingChatInput).toContain("LaTeX toolchain");
    expect(useStore.getState().pendingChatInput).toContain("ask for my approval");
  });

  it("creates a presentation root document from the library template", async () => {
    mockProjectFiles();

    render(<Typeset />);

    fireEvent.click(await screen.findByRole("button", { name: "New LaTeX document" }));
    fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Research talk" } });
    fireEvent.click(screen.getByRole("radio", { name: /Presentation/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create document" }));

    await waitFor(() => expect(mocks.fileCreateText).toHaveBeenCalledWith(
      ".somniq/slides/Research-talk/main.tex",
      expect.stringContaining("\\documentclass[aspectratio=169]{beamer}"),
    ));
  });

  it("returns to the source start page after opening a file", async () => {
    mockProjectFiles();

    render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));
    expect(await screen.findByRole("button", { name: "Home" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toContain("\\section{Local}"));

    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    expect(await screen.findByRole("heading", { name: "All documents" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search by title or path")).toBeTruthy();
    expect(screen.queryByText("Open LaTeX source")).toBeNull();
    expect(screen.getByText("other.tex")).toBeTruthy();
    expect(screen.getByText("paper.tex")).toBeTruthy();
  });

  it("does not discard an unsaved draft when another tex file is clicked", async () => {
    mockProjectFiles();
    const localSource = "\\documentclass{article}\n\\begin{document}\nLocal draft\n\\end{document}";
    const otherSource = "\\documentclass{article}\n\\begin{document}\nOther file\n\\end{document}";
    mocks.fileListDir.mockResolvedValue([
      { name: "local.tex", path: "sections/local.tex", isDir: false },
      { name: "other.tex", path: "sections/other.tex", isDir: false },
    ]);
    mocks.fileReadText
      .mockResolvedValueOnce({ path: "sections/local.tex", content: localSource, bytes: localSource.length })
      .mockResolvedValueOnce({ path: "sections/other.tex", content: otherSource, bytes: otherSource.length });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const view = await waitFor(() => {
      const item = typesetCodeView();
      expect(item).toBeTruthy();
      return item!;
    });
    const offset = view.state.doc.toString().indexOf("Local draft");
    view.dispatch({ changes: { from: offset, to: offset + "Local draft".length, insert: "Unsaved local draft" } });

    const tree = container.querySelector<HTMLElement>(".typeset-tree");
    fireEvent.click(within(tree!).getByText("other.tex"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.fileReadText).toHaveBeenCalledTimes(1);
    expect(typesetCodeView()?.state.doc.toString()).toContain("Unsaved local draft");

    fireEvent.click(within(tree!).getByText("other.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/other.tex"));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toContain("Other file"));
  });

  it("saves with the opened content version and preserves the draft on a conflict", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nOriginal\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: source,
      bytes: source.length,
      version: "sha256:opened-version",
    });
    mocks.fileWriteText.mockRejectedValueOnce(new Error("FILE_CONFLICT: paper.tex changed on disk"));
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const view = await waitFor(() => {
      const item = typesetCodeView();
      expect(item).toBeTruthy();
      return item!;
    });
    const offset = view.state.doc.toString().indexOf("Original");
    view.dispatch({ changes: { from: offset, to: offset + "Original".length, insert: "Protected draft" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledWith(
      "paper.tex",
      source.replace("Original", "Protected draft"),
      "sha256:opened-version",
    ));
    expect(await screen.findByText(/FILE_CONFLICT: paper\.tex changed on disk/)).toBeTruthy();
    expect(typesetCodeView()?.state.doc.toString()).toContain("Protected draft");
  });

  it("refreshes a clean editor when the file changed externally before compiling", async () => {
    mockProjectFiles();
    const opened = "\\documentclass{article}\n\\begin{document}\nOpened\n\\end{document}";
    const external = opened.replace("Opened", "External update");
    mocks.fileReadText
      .mockResolvedValueOnce({ path: "paper.tex", content: opened, bytes: opened.length, version: "sha256:v1" })
      .mockResolvedValueOnce({ path: "paper.tex", content: external, bytes: external.length, version: "sha256:v2" });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("button", { name: "Recompile" }));

    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith(
      "paper.tex",
      "paper.pdf",
      false,
      expect.stringMatching(/^typeset-/),
      false,
    ));
    expect((await screen.findAllByText(/changed outside SomniQ Studio/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toContain("External update"));
  });

  it("serializes repeated saves and writes an edit made during the first save afterward", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nOriginal\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: source,
      bytes: source.length,
      version: "sha256:v1",
    });
    let finishFirstSave: ((file: { path: string; content: string; bytes: number; version: string }) => void) | undefined;
    mocks.fileWriteText
      .mockImplementationOnce((_path: string, content: string) => new Promise((resolve) => {
        finishFirstSave = resolve;
        expect(content).toContain("First edit");
      }))
      .mockImplementationOnce((path: string, content: string) => Promise.resolve({
        path,
        content,
        bytes: content.length,
        version: "sha256:v3",
      }));
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const view = await waitFor(() => {
      expect(typesetCodeView()).toBeTruthy();
      return typesetCodeView()!;
    });
    const offset = view.state.doc.toString().indexOf("Original");
    view.dispatch({ changes: { from: offset, to: offset + "Original".length, insert: "First edit" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledTimes(1));

    const latestView = typesetCodeView()!;
    const firstOffset = latestView.state.doc.toString().indexOf("First edit");
    latestView.dispatch({ changes: { from: firstOffset, to: firstOffset + "First edit".length, insert: "Second edit" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(mocks.fileWriteText).toHaveBeenCalledTimes(1);
    finishFirstSave?.({
      path: "paper.tex",
      content: source.replace("Original", "First edit"),
      bytes: source.length,
      version: "sha256:v2",
    });

    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledTimes(2));
    expect(mocks.fileWriteText.mock.calls[1]).toEqual([
      "paper.tex",
      source.replace("Original", "Second edit"),
      "sha256:v2",
    ]);
  });

  it("soft-wraps long lines in Code mode without changing the LaTeX source", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      `Long paragraph: ${"forecasting ".repeat(48).trim()}`,
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() => expect(typesetCodeView()?.contentDOM.classList.contains("cm-lineWrapping")).toBe(true));
    expect(typesetCodeView()?.state.doc.toString()).toBe(source);
  });

  it("scopes the editor file tree to the opened source folder", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));
    await waitFor(() => expect(mocks.fileListDir).toHaveBeenCalledWith("sections"));

    const tree = container.querySelector<HTMLElement>(".typeset-tree");
    expect(tree).toBeTruthy();
    expect(within(tree!).getByText("sections")).toBeTruthy();
    expect(within(tree!).getByText("local.tex")).toBeTruthy();
    expect(within(tree!).getByText("nested")).toBeTruthy();
    expect(within(tree!).queryByText("drafts")).toBeNull();
    expect(within(tree!).queryByText("paper.tex")).toBeNull();
  });

  it("compiles the currently open source without switching the editor to the resolved root", async () => {
    mockProjectFiles();
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "main.tex",
      outputPath: "main.pdf",
      engine: "latexmk -xelatex",
      stdout: "",
      stderr: "",
      interrupted: false,
      timedOut: false,
      durationMs: 123,
      returnCodeInterpretation: null,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");

    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith(
      "sections/local.tex",
      "sections/local.pdf",
      false,
      expect.any(String),
      false,
    ));
    expect(container.querySelector(".typeset-visual-filebar strong")?.textContent).toBe("local.tex");
    await waitFor(() => expect(container.querySelector(".typeset-preview-file")?.textContent).toBe("main.pdf"));
  });

  it("clears LaTeX cache and recompiles from the compile options menu", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("button", { name: "Compile options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Clear cache & recompile/ }));

    await waitFor(() =>
      expect(mocks.latexCompile).toHaveBeenCalledWith("paper.tex", "paper.pdf", true, expect.any(String), false),
    );
  });

  it("groups compile diagnostics into filterable expandable log cards", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\\n\\begin{document}\\nBody text\\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: false,
      partialOutput: false,
      pdfState: "missing",
      outputPath: "paper.pdf",
      engine: "latexmk -xelatex",
      stdout: "LaTeX Warning: Overfull \\hbox (12pt too wide) in paragraph at lines 10--11.",
      stderr: "! Misplaced alignment tab character &.\\nl.12 Value & detail",
      interrupted: false,
      timedOut: false,
      durationMs: 44,
      rootSourceHash: "abcdef0123456789",
      diagnostics: [
        { severity: "error", code: "table_alignment", message: "Misplaced alignment tab character &.", filePath: "paper.tex", line: 12 },
        { severity: "warning", code: "latex_warning", message: "Package hyperref Warning: Ignoring empty anchor", filePath: "paper.tex", line: 9 },
        { severity: "warning", code: "latex_warning", message: "Overfull \\hbox (12pt too wide)", filePath: "paper.tex", line: 10 },
      ],
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    const log = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('section[aria-label="Compile log"]');
      expect(element).toBeTruthy();
      return element!;
    });
    expect(container.querySelectorAll(".typeset-recompile-btn")).toHaveLength(1);
    expect(log.querySelector(".typeset-log-recompile")).toBeNull();
    expect(within(log).queryByRole("button", { name: "Back to PDF" })).toBeNull();
    await waitFor(() => expect(within(log).getByRole("tab", { name: "All logs 3" })).toBeTruthy());
    expect(within(log).getByRole("tab", { name: "Errors 1" })).toBeTruthy();
    expect(within(log).getByRole("tab", { name: "Warnings 1" })).toBeTruthy();
    expect(within(log).getByRole("tab", { name: "Info 1" })).toBeTruthy();
    expect(log.querySelectorAll(".typeset-diagnostic-card")).toHaveLength(3);
    expect(within(log).getByText("An alignment character (&) was used outside a table or alignment environment. Escape it as \\& when it is ordinary text.")).toBeTruthy();

    fireEvent.click(within(log).getByRole("tab", { name: "Info 1" }));
    expect(log.querySelectorAll(".typeset-diagnostic-card")).toHaveLength(1);
    expect(within(log).getByText("Overfull \\hbox (12pt too wide)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Compile log" }));
    expect(container.querySelector('section[aria-label="Compile log"]')).toBeNull();
  });

  it("resolves diagnostic files from the compile root without basename collisions", async () => {
    mockProjectFiles();
    const currentSource = "\\documentclass{article}\n\\begin{document}\nCurrent\n\\end{document}";
    const diagnosticSource = "Nested diagnostic source";
    mocks.fileReadText
      .mockResolvedValueOnce({ path: "sections/local.tex", content: currentSource, bytes: currentSource.length })
      .mockResolvedValueOnce({ path: "papers/chapters/local.tex", content: diagnosticSource, bytes: diagnosticSource.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: false,
      inputPath: "papers/main.tex",
      outputPath: "papers/main.pdf",
      engine: "latexmk -xelatex",
      stdout: "",
      stderr: "Nested failure",
      interrupted: false,
      timedOut: false,
      durationMs: 12,
      partialOutput: false,
      pdfState: "missing",
      rootSourceHash: "manifest",
      diagnostics: [
        { severity: "error", code: "latex_error", message: "Nested failure", filePath: "chapters/local.tex", line: 7 },
      ],
    });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");
    await recompileOpenSource();
    fireEvent.click(await screen.findByRole("button", { name: "Nested failure" }));

    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("papers/chapters/local.tex"));
    await waitFor(() => expect(container.querySelector(".typeset-visual-filebar strong")?.textContent).toBe("local.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toContain("Nested diagnostic source"));
  });

  it("renders the compile options control with an SVG icon", async () => {
    mockProjectFiles();
    render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Compile options" })).toBeTruthy());

    expect(screen.getByRole("button", { name: "Compile options" }).querySelector("svg")).toBeTruthy();
  });

  it("selects PDF zoom from the toolbar and displays current and total pages", async () => {
    mockProjectFiles();
    pdfMocks.document.numPages = 3;
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    const pageInput = await screen.findByRole("textbox", { name: "Current PDF page" }) as HTMLInputElement;
    expect(pageInput.value).toBe("1");
    expect(screen.getByLabelText("3 PDF pages").textContent).toBe("/ 3");
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /PDF zoom \d+%/ }));
    const zoomMenu = await screen.findByRole("menu", { name: "PDF zoom menu" });
    fireEvent.click(within(zoomMenu).getByRole("menuitemradio", { name: "150%" }));
    expect(screen.getByRole("button", { name: "PDF zoom 150%" })).toBeTruthy();

    const pages = container.querySelectorAll<HTMLElement>(".typeset-pdf-page");
    const scroll = container.querySelector<HTMLElement>(".typeset-pdf-scroll");
    expect(pages).toHaveLength(3);
    expect(scroll).toBeTruthy();
    fireEvent.wheel(scroll!, { ctrlKey: true, deltaY: -100 });
    await waitFor(() => expect(screen.getByRole("button", { name: "PDF zoom 160%" })).toBeTruthy());
    Object.defineProperty(scroll!, "clientHeight", { configurable: true, value: 120 });
    pages.forEach((page, index) => {
      Object.defineProperty(page, "offsetTop", { configurable: true, value: index * 160 });
      Object.defineProperty(page, "offsetHeight", { configurable: true, value: 120 });
    });
    scroll!.scrollTop = 180;
    fireEvent.scroll(scroll!);

    await waitFor(() => expect(pageInput.value).toBe("2"));

    container.querySelectorAll<HTMLElement>(".typeset-pdf-page").forEach((page, index) => {
      Object.defineProperty(page, "offsetTop", { configurable: true, value: index * 160 });
      Object.defineProperty(page, "offsetHeight", { configurable: true, value: 120 });
    });

    const scrollTo = vi.fn();
    Object.defineProperty(scroll!, "scrollTo", { configurable: true, value: scrollTo });
    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "3" } });
    fireEvent.keyDown(pageInput, { key: "Enter" });

    expect(pageInput.value).toBe("3");
    expect(scrollTo).toHaveBeenCalledWith({ top: 308, behavior: "auto" });

    fireEvent.blur(pageInput);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(pageInput.value).toBe("2");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 148, behavior: "smooth" });

    fireEvent.focus(pageInput);
    fireEvent.keyDown(pageInput, { key: "ArrowRight" });
    expect(pageInput.value).toBe("2");
  });

  it("only mounts canvases for the visible window of a long PDF", async () => {
    mockProjectFiles();
    pdfMocks.document.numPages = 93;
    const source = "\\documentclass{article}\n\\begin{document}\nLong PDF\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await screen.findByLabelText("93 PDF pages");

    await waitFor(() => expect(container.querySelectorAll(".typeset-pdf-page")).toHaveLength(93));
    expect(container.querySelectorAll(".typeset-pdf-page canvas").length).toBeLessThanOrEqual(3);
    expect(container.querySelectorAll(".typeset-pdf-page-placeholder").length).toBeGreaterThanOrEqual(90);

    fireEvent.click(screen.getByRole("button", { name: /PDF zoom \d+%/ }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "PDF zoom menu" })).getByRole("menuitemradio", { name: "400%" }));
    await waitFor(() => expect(container.querySelectorAll(".typeset-pdf-page canvas").length).toBeLessThanOrEqual(1));
  });

  it("renders every page that is visible at once instead of leaving a white placeholder", async () => {
    mockProjectFiles();
    pdfMocks.document.numPages = 12;
    const source = "\\documentclass{article}\n\\begin{document}\nWide viewport\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await screen.findByLabelText("12 PDF pages");

    fireEvent.click(screen.getByRole("button", { name: /PDF zoom \d+%/ }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "PDF zoom menu" })).getByRole("menuitemradio", { name: "150%" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "PDF zoom 150%" })).toBeTruthy());

    const scroll = container.querySelector<HTMLElement>(".typeset-pdf-scroll");
    const pages = Array.from(container.querySelectorAll<HTMLElement>(".typeset-pdf-page"));
    expect(scroll).toBeTruthy();
    expect(pages).toHaveLength(12);
    Object.defineProperty(scroll!, "clientHeight", { configurable: true, value: 480 });
    pages.forEach((page, index) => {
      Object.defineProperty(page, "offsetTop", { configurable: true, value: index * 160 });
      Object.defineProperty(page, "offsetHeight", { configurable: true, value: 120 });
    });
    scroll!.scrollTop = 320;
    fireEvent.scroll(scroll!);

    // Page 5 is visible below the reading edge at 150% zoom. Previously it
    // remained a blank placeholder until the reader scrolled much farther.
    await waitFor(() => {
      const renderedPages = Array.from(container.querySelectorAll<HTMLElement>(".typeset-pdf-page"))
        .flatMap((page, index) => page.querySelector("canvas") ? [index + 1] : []);
      expect(renderedPages).toContain(5);
    });
  });

  it("updates the compile log from progress events before compilation completes", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    let resolveCompile: ((result: { success: boolean; outputPath: string; engine: string; durationMs: number }) => void) | undefined;
    let progressHandler: ((event: { runId: string; stdout: string; stderr: string; elapsedMs: number }) => void) | undefined;
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    mocks.onLatexCompileProgress.mockImplementation((handler) => {
      progressHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.latexCompile.mockImplementation((_input, _output, _clean, runId) => new Promise((resolve) => {
      resolveCompile = resolve;
      progressHandler?.({ runId, stdout: "Latexmk: processing paper.tex", stderr: "", elapsedMs: 1100 });
    }));

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    // The log no longer auto-opens while compiling, so open it to watch progress.
    fireEvent.click(screen.getByRole("button", { name: "Compile log" }));
    await recompileOpenSource();

    expect(await screen.findByText("Latexmk: processing paper.tex")).toBeTruthy();
    resolveCompile?.({ success: true, outputPath: "paper.pdf", engine: "latexmk -pdf", durationMs: 12 });
    await waitFor(() => expect(screen.getAllByText("latexmk -pdf in 12 ms").length).toBeGreaterThan(0));
  });

  it("opens file actions from the Typeset tree context menu", async () => {
    mockProjectFiles();
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");
    const tree = container.querySelector<HTMLElement>(".typeset-tree");
    const row = within(tree!).getByText("notes.md").closest("button");
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row!);

    const menu = await screen.findByRole("menu", { name: "File actions" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Copy path",
      "Duplicate",
      "Show in folder",
      "Rename",
      "Delete",
    ]);
  });

  it("syncs edits from the current visual editor back to Code mode", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\n\\section{Local}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({
      path: "sections/local.tex",
      content: source,
      bytes: source.length,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const view = await waitFor(() => {
      const item = (window as unknown as {
        __typesetView?: {
          state: { doc: { toString: () => string } };
          dispatch: (transaction: { changes: { from: number; to: number; insert: string } }) => void;
        };
      }).__typesetView;
      expect(item).toBeTruthy();
      return item!;
    });
    const from = view.state.doc.toString().indexOf("Local");
    expect(from).toBeGreaterThanOrEqual(0);
    view.dispatch({ changes: { from, to: from + "Local".length, insert: "Edited title" } });

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() =>
      expect(typesetCodeView()?.state.doc.toString()).toContain("\\section{Edited title}"),
    );
  });

  it("uses the VS Code LaTeX highlight theme for revealed Visual source", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\n\\section{Local}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({
      path: "sections/local.tex",
      content: source,
      bytes: source.length,
    });

    render(<Typeset />);
    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(document.body, "sections/local.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const view = await waitFor(() => {
      const item = window.__typesetView;
      expect(item).toBeTruthy();
      return item!;
    });
    const from = view.state.doc.toString().indexOf("\\section");
    view.dispatch({ selection: { anchor: from } });

    await waitFor(() => {
      const className = highlightingFor(view.state, [t.tagName]);
      expect(className).toBeTruthy();
      expect(
        Array.from(view.dom.querySelectorAll("span")).some(
          (element) => element.textContent === "\\section" && element.className.includes(className!),
        ),
      ).toBe(true);
    });
  });

  it("compiles the latest Visual edit without requiring a mode switch", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\\n\\begin{document}\\nOriginal text\\n\\end{document}";
    const edited = "Visual edit";
    const expected = source.replace("Original text", edited);
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const view = await waitFor(() => {
      const item = (window as unknown as {
        __typesetView?: {
          state: { doc: { toString: () => string } };
          dispatch: (transaction: { changes: { from: number; to: number; insert: string } }) => void;
        };
      }).__typesetView;
      expect(item).toBeTruthy();
      return item!;
    });
    const from = view.state.doc.toString().indexOf("Original text");
    view.dispatch({ changes: { from, to: from + "Original text".length, insert: edited } });

    await recompileOpenSource();

    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledWith("paper.tex", expected));
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith(
      "paper.tex",
      "paper.pdf",
      false,
      expect.any(String),
      false,
    ));
  });

  it("preserves the active selection when switching between Visual and Code", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const visualView = await waitFor(() => {
      const view = (window as unknown as {
        __typesetView?: { dispatch: (transaction: { selection: { anchor: number; head: number } }) => void };
      }).__typesetView;
      expect(view).toBeTruthy();
      return view!;
    });
    const start = source.indexOf("Body text");
    visualView.dispatch({ selection: { anchor: start, head: start + "Body text".length } });

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() => {
      const selection = typesetCodeView()?.state.selection.main;
      expect(selection?.from).toBe(start);
      expect(selection?.to).toBe(start + "Body text".length);
    });
  });

  it("shows Beamer slide navigation and keeps slide jumps in Visual mode", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "First slide.",
      "\\end{frame}",
      "\\begin{frame}{Method}",
      "Second slide.",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    pdfMocks.document.numPages = 2;
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const navigation = await screen.findByRole("navigation", { name: "Slide navigation" });
    expect(navigation.textContent).toContain("Slide 1 / 2");
    expect(navigation.textContent).toContain("Motivation");
    const compiledVisual = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-compiled-visual");
      expect(item).toBeTruthy();
      return item!;
    });
    expect(within(compiledVisual).getByRole("button", { name: "Exit slide focus" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "PDF preview" })).toBeNull();
    expect(within(compiledVisual).getByText(/Slide 1 \/ 2/)).toBeTruthy();
    expect(within(compiledVisual).getByRole("button", { name: "Fit slide to canvas" })).toBeTruthy();
    expect(within(compiledVisual).getByRole("button", { name: "Edit slide source" })).toBeTruthy();
    const deck = within(compiledVisual).getByRole("navigation", { name: "Slide outline" });
    expect(within(deck).getByRole("button", { name: "Open slide 1: Motivation" }).getAttribute("aria-current")).toBe("page");
    expect(within(deck).getByRole("button", { name: "Open slide 2: Method" })).toBeTruthy();

    fireEvent.click(within(navigation).getByRole("button", { name: "Next slide" }));

    await waitFor(() => expect(navigation.textContent).toContain("Slide 2 / 2"));
    expect(navigation.textContent).toContain("Method");
    await waitFor(() => expect(within(compiledVisual).getByText(/Slide 2 \/ 2/)).toBeTruthy());
    expect(within(deck).getByRole("button", { name: "Open slide 2: Method" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("tab", { name: "Visual" }).getAttribute("aria-selected")).toBe("true");
    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();

    const slideCanvas = await within(compiledVisual).findByRole("group", { name: /Use left and right arrow keys/ });
    fireEvent.keyDown(slideCanvas, { key: "ArrowLeft" });
    await waitFor(() => expect(navigation.textContent).toContain("Slide 1 / 2"));
    fireEvent.click(within(compiledVisual).getByRole("button", { name: "Hide slide list" }));
    expect(within(compiledVisual).queryByRole("navigation", { name: "Slide outline" })).toBeNull();
    fireEvent.click(within(compiledVisual).getByRole("button", { name: "Show slide list" }));
    expect(within(compiledVisual).getByRole("navigation", { name: "Slide outline" })).toBeTruthy();

    fireEvent.click(within(compiledVisual).getByRole("button", { name: "Exit slide focus" }));
    expect(await screen.findByRole("region", { name: "PDF preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide Project files" })).toBeTruthy();
  });

  it("stages a direct Beamer text edit and compiles only when Save is clicked", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "Body text",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const compiledVisual = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-compiled-visual");
      expect(item).toBeTruthy();
      return item!;
    });
    const textButton = await within(compiledVisual).findByRole("button", { name: "Slide text object: Body text" });
    fireEvent.click(textButton);

    expect(screen.getByRole("tab", { name: "Visual" }).getAttribute("aria-selected")).toBe("true");
    expect(textButton.getAttribute("aria-pressed")).toBe("true");
    expect(within(compiledVisual).queryByRole("textbox", { name: "LaTeX source for current slide" })).toBeNull();

    fireEvent.doubleClick(textButton);
    const directEditor = await within(compiledVisual).findByRole("textbox", { name: "Edit slide text: Body text" }) as HTMLInputElement;
    fireEvent.change(directEditor, { target: { value: "Updated & 50%" } });
    fireEvent.keyDown(directEditor, { key: "Enter" });

    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();
    expect(within(compiledVisual).getByText("Draft · save to update preview")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledWith(
      "paper.tex",
      source.replace("Body text", "Updated \\& 50\\%"),
    ));
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("tab", { name: "Visual" }).getAttribute("aria-selected")).toBe("true");
  });

  it("scopes a direct text edit to the active slide when identical text appears on an earlier slide", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "Body text",
      "\\end{frame}",
      "\\begin{frame}{Method}",
      "Body text",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    pdfMocks.document.numPages = 2;
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const navigation = await screen.findByRole("navigation", { name: "Slide navigation" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Next slide" }));
    await waitFor(() => expect(navigation.textContent).toContain("Slide 2 / 2"));

    const compiledVisual = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-compiled-visual");
      expect(item).toBeTruthy();
      return item!;
    });
    const textButton = await within(compiledVisual).findByRole("button", { name: "Slide text object: Body text" });
    fireEvent.doubleClick(textButton);
    const directEditor = await within(compiledVisual).findByRole("textbox", { name: "Edit slide text: Body text" }) as HTMLInputElement;
    fireEvent.change(directEditor, { target: { value: "Slide two text" } });
    fireEvent.keyDown(directEditor, { key: "Enter" });

    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const expectedLines = source.split("\n");
    expectedLines[6] = "Slide two text";
    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledWith("paper.tex", expectedLines.join("\n")));
  });

  it("batches repeated slide moves and compiles once on Save", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "Body text",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const compiledVisual = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-compiled-visual");
      expect(item).toBeTruthy();
      return item!;
    });

    const textObject = await within(compiledVisual).findByRole("button", { name: "Slide text object: Body text" });
    fireEvent.pointerDown(textObject, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(textObject, { pointerId: 1, clientX: 60, clientY: 44 });
    fireEvent.pointerUp(textObject, { pointerId: 1, clientX: 60, clientY: 44 });

    // Both moves stay in the in-memory source draft until the user saves.
    const movedOnce = await within(compiledVisual).findByRole("button", { name: "Slide text object: Body text" });
    fireEvent.pointerDown(movedOnce, { button: 0, pointerId: 2, clientX: 60, clientY: 44 });
    fireEvent.pointerMove(movedOnce, { pointerId: 2, clientX: 90, clientY: 80 });
    fireEvent.pointerUp(movedOnce, { pointerId: 2, clientX: 90, clientY: 80 });

    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));
    const written = mocks.fileWriteText.mock.calls[0]?.[1] as string;
    expect(written.match(/% SOMNIQ-VISUAL-OBJECT id=/g)).toHaveLength(1);
  });

  it("drags a slide text object and writes an auditable TikZ overlay to LaTeX", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "Body text",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const compiledVisual = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-compiled-visual");
      expect(item).toBeTruthy();
      return item!;
    });
    const textObject = await within(compiledVisual).findByRole("button", { name: "Slide text object: Body text" });

    fireEvent.pointerDown(textObject, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(textObject, { pointerId: 1, clientX: 60, clientY: 44 });

    expect(compiledVisual.querySelectorAll(".typeset-slide-object-origin-mask")).toHaveLength(1);
    expect(within(compiledVisual).getAllByRole("button", { name: "Slide text object: Body text" })).toHaveLength(1);

    fireEvent.pointerUp(textObject, { pointerId: 1, clientX: 60, clientY: 44 });

    await new Promise((resolve) => window.setTimeout(resolve, 30));
    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();
    expect(compiledVisual.querySelectorAll(".typeset-slide-object-origin-mask")).toHaveLength(1);
    expect(within(compiledVisual).getAllByRole("button", { name: "Slide text object: Body text" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledTimes(1));
    const written = mocks.fileWriteText.mock.calls[mocks.fileWriteText.mock.calls.length - 1]?.[1] as string;
    expect(written).toContain("\\usepackage{tikz}");
    expect(written).toContain("% SOMNIQ-VISUAL-OBJECT id=");
    expect(written).toContain("\\begin{tikzpicture}[remember picture,overlay]");
    expect(written).toContain("current page.north west) {Body text}");
    expect(written).toContain("\\rule{");
    expect(written).toContain("% SOMNIQ-VISUAL-OBJECT-END id=");
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));

    mocks.fileWriteText.mockClear();
    mocks.latexCompile.mockClear();
    const movedAgain = await within(compiledVisual).findByRole("button", { name: "Slide text object: Body text" });
    fireEvent.pointerDown(movedAgain, { button: 0, pointerId: 2, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(movedAgain, { pointerId: 2, clientX: 48, clientY: 60 });
    fireEvent.pointerUp(movedAgain, { pointerId: 2, clientX: 48, clientY: 60 });

    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledTimes(1));
    const repositioned = mocks.fileWriteText.mock.calls[mocks.fileWriteText.mock.calls.length - 1]?.[1] as string;
    expect(repositioned.match(/% SOMNIQ-VISUAL-OBJECT id=/g)).toHaveLength(1);
    expect(repositioned.match(/\\usepackage\{tikz\}/g)).toHaveLength(1);
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));
  });

  it("adds a new text object from the Visual canvas toolbar", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Canvas}",
      "Existing content",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const compiledVisual = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-compiled-visual");
      expect(item).toBeTruthy();
      return item!;
    });
    fireEvent.click(within(compiledVisual).getByRole("button", { name: "Add text object" }));

    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledTimes(1));
    const written = mocks.fileWriteText.mock.calls[mocks.fileWriteText.mock.calls.length - 1]?.[1] as string;
    expect(written).toContain("\\usepackage{tikz}");
    expect(written).toContain("current page.north west) {New text}");
    expect(written.indexOf("New text")).toBeLessThan(written.indexOf("\\end{frame}"));
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));
  });

  it("uses the Overleaf-style continue-on-error setting for the next compile", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("button", { name: "Compile options" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Try to compile despite errors/ }));
    expect(window.localStorage.getItem("somniq-typeset-compile-error-handling:project-a")).toBe("continue");

    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith(
      "paper.tex",
      "paper.pdf",
      false,
      expect.any(String),
      true,
    ));
  });

  it("labels a recovered PDF as compiled with errors", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: false,
      partialOutput: true,
      outputPath: "paper.pdf",
      engine: "latexmk -pdf",
      stdout: "",
      stderr: "! Missing } inserted.",
      interrupted: false,
      timedOut: false,
      durationMs: 12,
    });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    expect((await screen.findAllByText("Compiled with errors")).length).toBeGreaterThan(0);
  });

  it("marks a failed build as stale instead of presenting its old PDF as new", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: false,
      partialOutput: false,
      pdfState: "stale",
      outputPath: "paper.pdf",
      engine: "latexmk -pdf",
      stdout: "",
      stderr: "! Missing } inserted.",
      interrupted: false,
      timedOut: false,
      durationMs: 12,
      rootSourceHash: "abcdef0123456789",
      pdfHash: "previous-pdf",
      compiledAtUnixMs: 1,
      diagnostics: [],
    });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    expect(await screen.findByText("Showing last verified PDF")).toBeTruthy();
    expect(screen.getByText("PDF: stale")).toBeTruthy();
  });

  it("cancels an active desktop compilation", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    let finish: ((result: unknown) => void) | undefined;
    mocks.latexCompile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("button", { name: "Recompile" }));
    const stop = await screen.findByRole("button", { name: "Stop compilation" });
    fireEvent.click(stop);
    await waitFor(() => expect(mocks.latexCompileCancel).toHaveBeenCalledWith(expect.stringMatching(/^typeset-/)));

    finish?.({ success: false, partialOutput: false, pdfState: "missing", outputPath: "paper.pdf", engine: "latexmk", stdout: "", stderr: "interrupted", interrupted: true, timedOut: false, durationMs: 1, rootSourceHash: "x", diagnostics: [] });
  });

  it("cancels and ignores a compile result after switching source files", async () => {
    mockProjectFiles();
    const sourceA = "\\documentclass{article}\n\\begin{document}\nSource A\n\\end{document}";
    const sourceB = "\\documentclass{article}\n\\begin{document}\nSource B\n\\end{document}";
    mocks.fileListDir.mockResolvedValue([
      { name: "local.tex", path: "sections/local.tex", isDir: false },
      { name: "other.tex", path: "sections/other.tex", isDir: false },
    ]);
    mocks.fileReadText
      .mockResolvedValueOnce({ path: "sections/local.tex", content: sourceA, bytes: sourceA.length })
      .mockResolvedValueOnce({ path: "sections/other.tex", content: sourceB, bytes: sourceB.length });
    let finishCompile: ((result: unknown) => void) | undefined;
    mocks.latexCompile.mockImplementationOnce(() => new Promise((resolve) => { finishCompile = resolve; }));
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");
    fireEvent.click(screen.getByRole("button", { name: "Recompile" }));
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));
    const runId = mocks.latexCompile.mock.calls[0]?.[3] as string;

    const tree = container.querySelector<HTMLElement>(".typeset-tree");
    fireEvent.click(within(tree!).getByText("other.tex"));
    await waitForSourceOpen(container, "sections/other.tex", "other.tex");
    await waitFor(() => expect(mocks.latexCompileCancel).toHaveBeenCalledWith(runId));

    finishCompile?.({
      success: true,
      outputPath: "sections/local.pdf",
      engine: "stale-a-compiler",
      stdout: "stale A result",
      stderr: "",
      durationMs: 5,
    });
    await waitFor(() => {
      expect(container.querySelector(".typeset-visual-filebar strong")?.textContent).toBe("other.tex");
      expect(container.querySelector(".typeset-preview-file")?.textContent).not.toBe("local.pdf");
      expect(screen.queryByText("stale A result")).toBeNull();
    });
  });

  it("keeps frame source edits local until Ctrl+S saves and recompiles", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Motivation}",
      "Body text",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    const compiledVisual = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-compiled-visual");
      expect(item).toBeTruthy();
      return item!;
    });
    fireEvent.click(within(compiledVisual).getByRole("button", { name: "Edit slide source" }));
    const sourceEditor = within(compiledVisual).getByRole("textbox", { name: "LaTeX source for current slide" }) as HTMLTextAreaElement;
    fireEvent.change(sourceEditor, { target: { value: sourceEditor.value.replace("Body text", "Updated visual text") } });

    expect(within(compiledVisual).getByText("Draft · save to update preview")).toBeTruthy();
    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();
    fireEvent.keyDown(sourceEditor, { key: "s", ctrlKey: true });

    await waitFor(() => expect(mocks.fileWriteText).toHaveBeenCalledWith("paper.tex", source.replace("Body text", "Updated visual text")));
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));
  });

  it("renders rich LaTeX source in the current visual editor", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass[11pt,a4paper]{article}",
      "\\title{USTMS Guide}",
      "\\begin{document}",
      "\\maketitle",
      "\\section{Introduction}",
      "Visual mode should show body content.",
      "\\begin{itemize}",
      "\\item First point",
      "\\end{itemize}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const visualContent = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-visual-cm .cm-content");
      expect(item).toBeTruthy();
      return item!;
    });
    expect(visualContent.textContent).toContain("USTMS Guide");
    expect(visualContent.textContent).toContain("Visual mode should show body content.");
    await waitFor(() => expect(visualContent.querySelectorAll(".cm-vis-item-marker-bullet")).toHaveLength(1));
    expect(container.querySelector(".typeset-visual-block")).toBeNull();
  });

  it("renders enumitem labels in the visual editor without exposing list setup", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\usepackage{enumitem}",
      "\\begin{document}",
      "\\begin{enumerate}[label=步骤 \\arabic*,leftmargin=*]",
      "\\item First research step",
      "\\item Second research step",
      "\\end{enumerate}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const visualContent = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-visual-cm .cm-content");
      expect(item).toBeTruthy();
      expect(item?.querySelectorAll(".cm-vis-item-marker")).toHaveLength(2);
      return item!;
    });
    expect(Array.from(visualContent.querySelectorAll(".cm-vis-item-marker"), (item) => item.textContent))
      .toEqual(["步骤 1", "步骤 2"]);
    expect(visualContent.textContent).not.toContain("\\begin{enumerate}");
    expect(visualContent.textContent).not.toContain("leftmargin");
  });

  it("keeps rich formatting active across consecutive paper paragraphs and lists", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\usepackage{enumitem}",
      "\\begin{document}",
      "\\[",
      "\\text{人驾驶产生 }x(t) \\Rightarrow \\hat K_h \\Rightarrow \\hat Q,\\hat S,\\hat\\gamma \\Rightarrow \\text{机器用恢复出的代价生成控制}",
      "\\]",
      "\\noindent\\textbf{模拟}: 设专家权重 $Q=\\mathrm{diag}(0.1,0.1,1,1)$,$S=0$,$\\gamma=0.5$,由 ARE 算出真 $K_h$(式 (49))。两种工况:",
      "\\begin{itemize}[leftmargin=*]",
      "  \\item \\textbf{Case 1} $w=1800\\sin t$: $t_f=20\\text{s}$ 时 $\\hat K_h(t_f)$ 与 $K_h$ 接近(式 (50)),优化得 $\\hat Q^*,\\\\hat S^*,\\hat\\gamma^*$(式 (51))与真值吻合;",
      "  \\item \\textbf{Case 2} $w\\equiv 0$: 状态收敛到 0,$\\hat K_h$ 精确收敛到 $K_h$。",
      "\\end{itemize}",
      "",
      "\\noindent\\textbf{实机}: Thrustmaster 方向盘 + PreScan,工况 $w=340e^{-0.2t}$,$\\hat K_h(t_f)$ 见式 (53),与模拟 Case 1 的 (50) 接近。",
      "",
      "\\subsection{论文 Section V 的核心结论}",
      "\\begin{itemize}[leftmargin=*]",
      "  \\item 把 HiTL 系统建模为零和 LQ 微分博弈,人是带未知代价函数的理性玩家;",
      "  \\item 通过 ICL 自适应律在线估计人的反馈矩阵 $K_h$,无需持续激励条件;",
      "  \\item 论文的创新在于: 同时去除了 \\textbf{PE 条件} 和 \\textbf{需要测量 $u$} 这两个传统在线 IRL 算法的限制。",
      "\\end{itemize}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const visualContent = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-visual-cm .cm-content");
      expect(item?.querySelectorAll(".cm-vis-item-marker")).toHaveLength(5);
      return item!;
    });
    expect(visualContent.textContent).toContain("模拟");
    expect(visualContent.textContent).toContain("论文 Section V 的核心结论");
    expect(visualContent.textContent).not.toContain("\\noindent");
    expect(visualContent.textContent).not.toContain("\\textbf");
    expect(visualContent.textContent).not.toContain("\\begin{itemize}");
    expect(visualContent.textContent).not.toContain("\\subsection");
  });

  it("does not let an unclosed inline formula expose the following paper content", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "$unfinished formula copied from notes",
      "\\noindent\\textbf{模拟}: 后续段落仍应保持 Visual 显示。",
      "\\begin{itemize}[leftmargin=*]",
      "  \\item \\textbf{Case 1}: $K_h$ 正常收敛。",
      "  \\item \\textbf{Case 2}: 状态收敛。",
      "\\end{itemize}",
      "\\subsection{后续结论}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const visualContent = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-visual-cm .cm-content");
      expect(item?.querySelectorAll(".cm-vis-item-marker")).toHaveLength(2);
      return item!;
    });
    expect(visualContent.textContent).toContain("模拟");
    expect(visualContent.textContent).toContain("后续结论");
    expect(visualContent.textContent).not.toContain("\\noindent");
    expect(visualContent.textContent).not.toContain("\\textbf");
    expect(visualContent.textContent).not.toContain("\\begin{itemize}");
    expect(visualContent.textContent).not.toContain("\\subsection");
  });

  it("keeps list and theorem declarations visual when their marker has the caret", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\begin{theorem}[Theorem 2]",
      "设 $\\lVert\\phi\\rVert \\leq \\phi_0$。",
      "\\end{theorem}",
      "\\begin{enumerate}[label=步骤 \\arabic*,leftmargin=*]",
      "  \\item 第一项。",
      "  \\item 第二项。",
      "\\end{enumerate}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));
    const view = await waitFor(() => {
      const item = window.__typesetView;
      expect(item).toBeTruthy();
      return item!;
    });

    view.dispatch({ selection: { anchor: source.indexOf("\\begin{theorem}") } });
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".cm-vis-theorem-label")?.textContent).toBe("Theorem 2");
      expect(container.querySelector<HTMLElement>(".typeset-visual-cm .cm-content")?.textContent).not.toContain("\\begin{theorem}");
    });

    view.dispatch({ selection: { anchor: source.indexOf("\\begin{enumerate}") } });
    await waitFor(() => {
      const visualContent = container.querySelector<HTMLElement>(".typeset-visual-cm .cm-content");
      expect(visualContent?.textContent).not.toContain("\\begin{enumerate}");
      expect(Array.from(visualContent?.querySelectorAll(".cm-vis-item-marker") ?? [], (item) => item.textContent))
        .toEqual(["步骤 1", "步骤 2"]);
    });
  });

  it("opens the complete theorem source in Code mode when its Visual label is double-clicked", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\begin{theorem}[Theorem 2]",
      "设 $x > 0$。",
      "\\end{theorem}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));
    const label = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".cm-vis-theorem-label");
      expect(item).toBeTruthy();
      return item!;
    });

    fireEvent.click(label);
    expect(screen.getByRole("tab", { name: "Visual" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.doubleClick(label);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
      const selection = typesetCodeView()?.state.selection.main;
      expect(selection?.from).toBe(source.indexOf("\\begin{theorem}"));
      expect(selection?.to).toBe(source.indexOf("\\end{theorem}") + "\\end{theorem}".length);
    });
  });

  it("double-clicking the rendered title jumps to Code mode with the \\title{} source selected", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\title{My Paper Title}",
      "\\author{Jane Doe}",
      "\\begin{document}",
      "\\maketitle",
      "Body text",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const titleEl = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".cm-vis-title-name");
      expect(item).toBeTruthy();
      return item!;
    });
    fireEvent.doubleClick(titleEl);

    await waitFor(() => expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => {
      const view = typesetCodeView();
      expect(view).toBeTruthy();
      const { from, to } = view!.state.selection.main;
      expect(view!.state.doc.toString().slice(from, to)).toBe("My Paper Title");
    });
  });

  it("double-clicking the rendered author jumps to Code mode with the \\author{} source selected", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\title{My Paper Title}",
      "\\author{Jane Doe}",
      "\\begin{document}",
      "\\maketitle",
      "Body text",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const authorEl = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".cm-vis-title-author");
      expect(item).toBeTruthy();
      return item!;
    });
    fireEvent.doubleClick(authorEl);

    await waitFor(() => expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => {
      const view = typesetCodeView();
      expect(view).toBeTruthy();
      const { from, to } = view!.state.selection.main;
      expect(view!.state.doc.toString().slice(from, to)).toBe("Jane Doe");
    });
  });

  it("Bold wraps the actual Visual-mode selection instead of inserting near \\end{document}", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const view = await waitFor(() => {
      const item = (window as unknown as {
        __typesetView?: {
          state: { doc: { toString: () => string } };
          dispatch: (transaction: { selection: { anchor: number; head: number } }) => void;
        };
      }).__typesetView;
      expect(item).toBeTruthy();
      return item!;
    });
    const from = view.state.doc.toString().indexOf("world");
    view.dispatch({ selection: { anchor: from, head: from + "world".length } });

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Bold" }));

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => {
      const text = typesetCodeView()?.state.doc.toString() ?? "";
      expect(text).toContain("Hello \\textbf{world}");
      expect(text).not.toContain("\\end{document}\\textbf");
    });
  });

  it("Bold wraps the actual Code-mode selection instead of inserting near \\end{document}", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const view = await waitFor(() => {
      const v = typesetCodeView();
      expect(v).toBeTruthy();
      return v!;
    });
    const from = view.state.doc.toString().indexOf("Hello");
    view.dispatch({ selection: { anchor: from, head: from + "Hello".length } });

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Bold" }));

    await waitFor(() => {
      expect(typesetCodeView()?.state.doc.toString()).toContain("\\textbf{Hello} world");
    });
  });

  it("Citation inserts at the cursor, not appended near \\end{document}", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nFirst.\nSecond.\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const view = await waitFor(() => {
      const v = typesetCodeView();
      expect(v).toBeTruthy();
      return v!;
    });
    const cursorPos = view.state.doc.toString().indexOf("First.") + "First.".length;
    view.dispatch({ selection: { anchor: cursorPos, head: cursorPos } });

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Insert citation" }));

    await waitFor(() => {
      const after = typesetCodeView()!;
      expect(after.state.doc.toString()).toBe(`${source.slice(0, cursorPos)}\\cite{reference}${source.slice(cursorPos)}`);
      const { from, to } = after.state.selection.main;
      expect(after.state.doc.toString().slice(from, to)).toBe("reference");
    });
  });

  it("selects a local library paper, persists its key, and synchronizes a separate managed bibliography", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nFirst.\n\\end{document}";
    mocks.fileReadText
      .mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length })
      .mockRejectedValueOnce(new Error("not found"));
    mocks.literatureLoad.mockResolvedValueOnce({
      version: 1,
      papers: [{
        id: "library-paper",
        title: "Citable Local Paper",
        authors: ["Ada Lovelace"],
        year: 2025,
        venue: "SomniQ Journal",
        abstract: "",
        tags: [],
        collectionIds: [],
        searchIds: [],
        stage: "inbox",
        starred: false,
        unread: true,
        source: "local",
        addedAt: "2026-07-20T00:00:00.000Z",
        pdf: { status: "none" },
        evidence: [],
        answerChains: [],
        pdfAnnotations: [],
      }],
      searches: [],
      collections: [],
      reviewTasks: [],
      screenRuns: [],
    });
    mocks.literatureExportBibliography.mockResolvedValueOnce({ content: "@article{ada2025citable,}", exported: 1 });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(useLiteratureStore.getState().library.papers).toHaveLength(1));

    const view = await waitFor(() => {
      const editor = typesetCodeView();
      expect(editor).toBeTruthy();
      return editor!;
    });
    const cursorPos = view.state.doc.toString().indexOf("First.") + "First.".length;
    view.dispatch({ selection: { anchor: cursorPos, head: cursorPos } });
    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Insert citation" }));
    fireEvent.click((await screen.findByText("Citable Local Paper")).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Insert \\cite{}" }));

    await waitFor(() => {
      const key = useLiteratureStore.getState().library.papers[0]?.citationKey;
      expect(key).toBeTruthy();
      expect(typesetCodeView()?.state.doc.toString()).toContain(`\\cite{${key}}`);
      expect(typesetCodeView()?.state.doc.toString()).toContain("\\bibliography{somniq-references}");
      expect(mocks.literatureExportBibliography).toHaveBeenCalledWith({ format: "bibtex" });
      expect(mocks.fileWriteText).toHaveBeenCalledWith(
        "somniq-references.bib",
        "% SomniQ managed bibliography — do not edit this file directly.\n@article{ada2025citable,}",
      );
      expect(mocks.fileWriteText).not.toHaveBeenCalledWith("references.bib", expect.anything());
    });
  });

  it("adds a managed resource and print command for BibLaTeX without replacing user resources", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\usepackage{biblatex}\n\\addbibresource{references.bib}\n\\begin{document}\nFirst.\n\\end{document}";
    mocks.fileReadText
      .mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length })
      .mockRejectedValueOnce(new Error("not found"));
    mocks.literatureLoad.mockResolvedValueOnce({
      version: 1,
      papers: [{
        id: "library-paper",
        title: "Citable Local Paper",
        authors: ["Ada Lovelace"],
        year: 2025,
        venue: "SomniQ Journal",
        abstract: "",
        tags: [],
        collectionIds: [],
        searchIds: [],
        stage: "inbox",
        starred: false,
        unread: true,
        source: "local",
        addedAt: "2026-07-20T00:00:00.000Z",
        pdf: { status: "none" },
        evidence: [],
        answerChains: [],
        pdfAnnotations: [],
      }],
      searches: [],
      collections: [],
      reviewTasks: [],
      screenRuns: [],
    });
    mocks.literatureExportBibliography.mockResolvedValueOnce({ content: "@article{ada2025citable,}", exported: 1 });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(useLiteratureStore.getState().library.papers).toHaveLength(1));

    const view = await waitFor(() => {
      const editor = typesetCodeView();
      expect(editor).toBeTruthy();
      return editor!;
    });
    const cursorPos = view.state.doc.toString().indexOf("First.") + "First.".length;
    view.dispatch({ selection: { anchor: cursorPos, head: cursorPos } });
    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Insert citation" }));
    fireEvent.click((await screen.findByText("Citable Local Paper")).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Insert \\cite{}" }));

    await waitFor(() => {
      const result = typesetCodeView()?.state.doc.toString() ?? "";
      expect(result).toContain("\\addbibresource{references.bib}");
      expect(result).toContain("\\addbibresource{somniq-references.bib}");
      expect(result).toContain("\\printbibliography");
      expect(result).not.toContain("\\bibliography{somniq-references}");
      expect(result.indexOf("\\addbibresource{somniq-references.bib}")).toBeLessThan(result.indexOf("\\begin{document}"));
      expect(result.indexOf("\\printbibliography")).toBeLessThan(result.indexOf("\\end{document}"));
    });
  });

  it("refreshes an established managed bibliography when local metadata changes", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nFirst.\n\\bibliographystyle{plain}\n\\bibliography{somniq-references}\n\\end{document}";
    mocks.fileReadText.mockImplementation((path: string) => Promise.resolve({
      path,
      content: path === "paper.tex" ? source : "% SomniQ managed bibliography — do not edit this file directly.\n",
      bytes: source.length,
    }));
    mocks.literatureLoad.mockResolvedValueOnce({
      version: 1,
      papers: [{
        id: "library-paper",
        title: "Citable Local Paper",
        citationKey: "lovelace2025citable",
        authors: ["Ada Lovelace"],
        year: 2025,
        venue: "SomniQ Journal",
        abstract: "",
        tags: [],
        collectionIds: [],
        searchIds: [],
        stage: "inbox",
        starred: false,
        unread: true,
        source: "local",
        addedAt: "2026-07-20T00:00:00.000Z",
        pdf: { status: "none" },
        evidence: [],
        answerChains: [],
        pdfAnnotations: [],
      }],
      searches: [],
      collections: [],
      reviewTasks: [],
      screenRuns: [],
    });
    mocks.literatureExportBibliography.mockResolvedValue({ content: "@article{lovelace2025citable,}", exported: 1 });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await waitFor(() => expect(mocks.literatureExportBibliography).toHaveBeenCalled());
    const beforeRefreshes = mocks.literatureExportBibliography.mock.calls.length;

    act(() => {
      useLiteratureStore.getState().updatePaperMetadata("library-paper", { title: "Updated Local Paper" });
    });
    await waitFor(() => {
      expect(mocks.literatureExportBibliography.mock.calls.length).toBeGreaterThan(beforeRefreshes);
    });
  });

  it("Section heading dropdown turns the current line into \\section{}", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nIntroduction\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const view = await waitFor(() => {
      const v = typesetCodeView();
      expect(v).toBeTruthy();
      return v!;
    });
    const cursorPos = view.state.doc.toString().indexOf("Introduction");
    view.dispatch({ selection: { anchor: cursorPos, head: cursorPos } });

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Section heading" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Section" }));

    await waitFor(() => {
      expect(typesetCodeView()?.state.doc.toString()).toContain("\\section{Introduction}");
    });
  });

  it("wires visual toolbar insert actions into undo and redo", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}",
      bytes: 80,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    expect(toolbar).toBeTruthy();
    const undo = within(toolbar!).getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    const redo = within(toolbar!).getByRole("button", { name: "Redo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);

    fireEvent.click(within(toolbar!).getByRole("button", { name: "Bold" }));
    expect(undo.disabled).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toContain("\\textbf{bold text}"));

    fireEvent.click(undo);
    await waitFor(() => {
      expect(typesetCodeView()?.state.doc.toString()).not.toContain("\\textbf{bold text}");
    });
    expect(redo.disabled).toBe(false);

    fireEvent.click(redo);
    await waitFor(() => {
      expect(typesetCodeView()?.state.doc.toString()).toContain("\\textbf{bold text}");
    });
  });

  it("saves visual editor changes with Ctrl+S", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}",
      bytes: 80,
    });

    render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));

    const toolbar = await waitFor(() => {
      const item = document.querySelector<HTMLElement>(".typeset-visual-toolbar");
      expect(item).toBeTruthy();
      return item!;
    });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Bold" }));
    await waitFor(() => expect((within(toolbar).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));

    expect(mocks.fileWriteText).not.toHaveBeenCalled();
    expect(mocks.latexCompile).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() =>
      expect(mocks.fileWriteText).toHaveBeenCalledWith(
        "paper.tex",
        expect.stringContaining("\\textbf{bold text}"),
      ),
    );
    // Ctrl+S in the article WYSIWYG editor only saves; compiling stays manual.
    expect(mocks.latexCompile).not.toHaveBeenCalled();
  });

  it("opens toolbar search and selects the matching source text", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: "\\documentclass{article}\n\\begin{document}\nAlpha\nBody text\n\\end{document}",
      bytes: 88,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    expect(toolbar).toBeTruthy();
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Search" }));
    const searchInput = await screen.findByLabelText("Search source");
    fireEvent.change(searchInput, { target: { value: "Body" } });
    fireEvent.submit(searchInput.closest("form")!);

    await waitFor(() => {
      const view = typesetCodeView();
      const text = view?.state.doc.toString() ?? "";
      const { from, to } = view?.state.selection.main ?? { from: -1, to: -1 };
      expect(from).toBe(text.indexOf("Body"));
      expect(to).toBe(text.indexOf("Body") + "Body".length);
    });
  });

  it("jumps from clicked PDF text to the matching LaTeX source in Code mode", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: "\\documentclass{article}\n\\begin{document}\nAlpha\nBody text\n\\end{document}",
      bytes: 88,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const pdfText = await screen.findByRole("button", { name: "Jump to source text: Body text" });
    fireEvent.click(pdfText);

    await waitFor(() => {
      const view = typesetCodeView();
      const start = view?.state.doc.toString().indexOf("Body text") ?? -1;
      const { from, to } = view?.state.selection.main ?? { from: -1, to: -1 };
      expect(from).toBe(start);
      expect(to).toBe(start + "Body text".length);
    });
  });

  it("jumps from clicked PDF text to the matching LaTeX source in Visual mode", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nAlpha\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: source,
      bytes: 88,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());

    const pdfText = await screen.findByRole("button", { name: "Jump to source text: Body text" });
    fireEvent.click(pdfText);

    const expectedStart = source.indexOf("Body text");
    await waitFor(() => {
      const view = (window as unknown as {
        __typesetView?: { state: { selection: { main: { from: number; to: number } } } };
      }).__typesetView;
      expect(container.querySelector(".typeset-editor-pane.visual-mode")).toBeTruthy();
      expect(container.querySelector(".lab-editor-input")).toBeNull();
      expect(view?.state.selection.main.from).toBe(expectedStart);
      expect(view?.state.selection.main.to).toBe(expectedStart);
    });
  });

  it("uses neighboring PDF text to disambiguate repeated source matches", async () => {
    mockProjectFiles();
    pdfMocks.getTextContent.mockResolvedValue({
      items: [
        { str: "UniqueBeta", transform: [10, 0, 0, 10, 24, 84], width: 60, height: 10 },
        { str: "Body text", transform: [10, 0, 0, 10, 24, 64], width: 48, height: 10 },
      ],
    });
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{UniqueAlpha}",
        "Body text",
        "\\section{UniqueBeta}",
        "Body text",
        "\\end{document}",
      ].join("\n"),
      bytes: 140,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const pdfText = await screen.findByRole("button", { name: "Jump to source text: Body text" });
    fireEvent.click(pdfText);

    await waitFor(() => {
      const view = typesetCodeView();
      const text = view?.state.doc.toString() ?? "";
      const first = text.indexOf("Body text");
      const second = text.indexOf("Body text", first + 1);
      const { from, to } = view?.state.selection.main ?? { from: -1, to: -1 };
      expect(from).toBe(second);
      expect(to).toBe(second + "Body text".length);
    });
  });

  it("forward-searches a double-click in Code mode into the compiled PDF (SyncTeX)", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nAlpha\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const view = await waitFor(() => {
      const codeView = typesetCodeView();
      expect(codeView).toBeTruthy();
      return codeView!;
    });
    const bodyTextOffset = source.indexOf("Body text");
    vi.spyOn(view, "posAtCoords").mockReturnValue(bodyTextOffset);
    fireEvent.dblClick(view.contentDOM, { clientX: 5, clientY: 5 });

    await waitFor(() => expect(mocks.latexForwardSearch).toHaveBeenCalledWith("paper.tex", "paper.pdf", 4, 1));
    await waitFor(() => expect(container.querySelector(".typeset-pdf-forward-highlight")).toBeTruthy());
  });

  it("forward-searches a double-click in Visual mode into the compiled PDF (SyncTeX)", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nAlpha\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());

    const view = await waitFor(() => {
      const visualView = (window as unknown as {
        __typesetView?: {
          contentDOM: HTMLElement;
          posAtCoords: (coords: { x: number; y: number }) => number | null;
        };
      }).__typesetView;
      expect(visualView).toBeTruthy();
      return visualView!;
    });
    const bodyTextOffset = source.indexOf("Body text");
    vi.spyOn(view, "posAtCoords").mockReturnValue(bodyTextOffset);
    fireEvent.dblClick(view.contentDOM, { clientX: 5, clientY: 5 });

    await waitFor(() => expect(mocks.latexForwardSearch).toHaveBeenCalledWith("paper.tex", "paper.pdf", 4, 1));
    await waitFor(() => expect(container.querySelector(".typeset-pdf-forward-highlight")).toBeTruthy());
  });

  it("jumps from the outline to the matching LaTeX section and shows the active section", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Intro}",
      "Opening text.",
      "",
      "More text.",
      "",
      "More text.",
      "",
      "More text.",
      "",
      "More text.",
      "",
      "More text.",
      "",
      "\\section{Method}",
      "Method text.",
      "\\subsection{Details}",
      "Detail text.",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const outline = screen.getByLabelText("Document outline");
    fireEvent.click(within(outline).getByRole("button", { name: /Method/ }));

    const expectedOffset = source.indexOf("\\section{Method}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => {
      const { from, to } = typesetCodeView()?.state.selection.main ?? { from: -1, to: -1 };
      expect(from).toBe(expectedOffset);
      expect(to).toBe(expectedOffset);
    });
    await waitFor(() => expect(mocks.latexForwardSearch).toHaveBeenCalledWith("paper.tex", "paper.pdf", 16, 1));
    await waitFor(() => expect(container.querySelector(".typeset-pdf-forward-highlight")).toBeTruthy());
    expect(container.querySelector<HTMLElement>(".typeset-current-section")?.textContent).toContain("Section 2 Method");
    expect(within(outline).getByRole("button", { name: /Method/ }).getAttribute("aria-current")).toBe("location");
  });

  it("recognizes chapters with short-title arguments and indents nested headings", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{report}",
      "\\begin{document}",
      "\\chapter[Intro]{Introduction to the field}",
      "\\section{Background}",
      "\\subsection{Prior work}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const outline = screen.getByLabelText("Document outline");
    // The \chapter[Short]{Full} form (previously dropped) is recognized and, as
    // the shallowest heading, renders flush-left; deeper headings step inward.
    const chapter = within(outline).getByRole("button", { name: /Introduction to the field/ });
    const section = within(outline).getByRole("button", { name: /Background/ });
    const subsection = within(outline).getByRole("button", { name: /Prior work/ });
    expect(chapter.getAttribute("data-level")).toBe("1");
    expect(section.getAttribute("data-level")).toBe("2");
    expect(subsection.getAttribute("data-level")).toBe("3");
    const pad = (button: HTMLElement) => parseInt(button.style.paddingLeft, 10);
    expect(pad(chapter)).toBeLessThan(pad(section));
    expect(pad(section)).toBeLessThan(pad(subsection));
  });

  it("uses Beamer frame titles when the document has no section outline", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "\\begin{frame}{Intro}",
      "Intro body.",
      "\\end{frame}",
      "\\begin{frame}{Method}",
      "Method body.",
      "\\end{frame}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("button", { name: "Exit slide focus" }));

    const outline = screen.getByLabelText("Document outline");
    expect(within(outline).getByRole("button", { name: /Intro/ })).toBeTruthy();
    const method = within(outline).getByRole("button", { name: /Method/ });
    fireEvent.click(method);

    await waitFor(() => expect(screen.getByRole("tab", { name: "Visual" }).getAttribute("aria-selected")).toBe("true"));
    const compiledVisual = await screen.findByRole("region", { name: "Compiled slide visual editor" });
    await waitFor(() => expect(within(compiledVisual).getByText("Method")).toBeTruthy());
  });

  it("updates the active section while the LaTeX editor scrolls", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Intro}",
      ...Array.from({ length: 28 }, (_, index) => `Intro line ${index}`),
      "\\section{Method}",
      "Method text.",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    // CodeMirror owns its own internal scroller (`.cm-scroller`) now — the
    // outer `.lab-editor` wrapper is `overflow: hidden` and no longer scrolls.
    const scroller = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-editor-body .lab-editor .cm-scroller");
      expect(item).toBeTruthy();
      return item!;
    });
    scroller.scrollTop = 720;
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(container.querySelector<HTMLElement>(".typeset-current-section")?.textContent).toContain("Section 2 Method"),
    );
  });

  it("resizes and toggles the outline panel", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Intro}",
      "Body text.",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const outline = container.querySelector<HTMLElement>(".typeset-outline");
    const divider = screen.getByRole("separator", { name: "Resize outline" });
    expect(outline?.style.flexBasis).toBe("33.333%");
    expect(outline?.style.flexShrink).toBe("1");

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientY: 300 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientY: 240 });

    await waitFor(() => {
      expect(outline?.style.flexBasis).toBe("244px");
      expect(outline?.style.flexShrink).toBe("0");
    });

    fireEvent.pointerUp(window, { pointerType: "mouse", clientY: 240 });
    fireEvent.click(screen.getByRole("button", { name: "Hide outline" }));

    await waitFor(() => expect(container.querySelector(".typeset-outline")).toBeNull());
    expect(screen.getByRole("button", { name: /Outline/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Outline/ }));
    await waitFor(() => expect(container.querySelector<HTMLElement>(".typeset-outline")?.style.flexBasis).toBe("244px"));
  });

  it("keeps an empty outline at one third height and resizable", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text.\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const outline = container.querySelector<HTMLElement>(".typeset-outline.empty");
    const divider = screen.getByRole("separator", { name: "Resize outline" });
    expect(outline?.style.flexBasis).toBe("33.333%");

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientY: 300 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientY: 260 });

    await waitFor(() => expect(outline?.style.flexBasis).toBe("224px"));
    fireEvent.pointerUp(window, { pointerType: "mouse", clientY: 260 });
  });

  it("keeps resizing panels after the mouse leaves the divider", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const divider = screen.getByRole("separator", { name: "Resize Project files" });
    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");
    expect(divider.querySelector(".typeset-resize-handle-hit")).toBeTruthy();

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientX: 260, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 324 });

    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("268px"));

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 324 });
  });

  it("starts resizing from mouse down", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const divider = screen.getByRole("separator", { name: "Resize Project files" });
    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientX: 260 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 324 });

    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("268px"));

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 324 });
  });

  it("keeps tracking the mouse across multiple moves within one drag", async () => {
    // Regression: updating the width state must not tear down the window drag
    // listeners mid-drag. A single move used to work while every move after the
    // first was dropped, making the divider feel unresizable.
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const divider = screen.getByRole("separator", { name: "Resize Project files" });
    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientX: 260, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 324 });
    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("268px"));
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 300 });
    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("244px"));
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 360 });
    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("304px"));

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 360 });
  });

  it("resizes stacked panels vertically on narrow layouts", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const divider = screen.getByRole("separator", { name: "Resize Project files" });
    vi.spyOn(divider, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: 180,
      width: 400,
      height: 8,
      top: 180,
      right: 440,
      bottom: 188,
      left: 40,
      toJSON: () => ({}),
    } as DOMRect);
    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientX: 260, clientY: 184 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 260, clientY: 232 });

    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("252px"));

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 260, clientY: 232 });
  });

  it("resizes the PDF preview from its divider", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const divider = screen.getByRole("separator", { name: "Resize PDF preview" });
    expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("760px");

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientX: 900, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 852 });

    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("808px"));

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 852 });
  });

  it("does not resize from project content beside the hidden divider", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const projectPanel = container.querySelector<HTMLElement>(".typeset-left-panel");
    expect(projectPanel).toBeTruthy();
    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");

    fireEvent.pointerDown(projectPanel!, { button: 0, pointerType: "mouse", clientX: 230, clientY: 200 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 286, clientY: 200 });

    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 286, clientY: 200 });
  });

  it("does not resize from PDF content beside the hidden divider", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const preview = container.querySelector<HTMLElement>(".typeset-preview-stack");
    expect(preview).toBeTruthy();
    expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("760px");

    fireEvent.pointerDown(preview!, { button: 0, pointerType: "mouse", clientX: 958, clientY: 200 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 902, clientY: 200 });

    expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("760px");

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 902, clientY: 200 });
  });

  it("does not resize when clicking the editor scrollbar gutter", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const editor = container.querySelector<HTMLElement>(".typeset-editor-body .lab-editor");
    vi.spyOn(editor!, "getBoundingClientRect").mockReturnValue({
      x: 260,
      y: 76,
      width: 670,
      height: 644,
      top: 76,
      right: 930,
      bottom: 720,
      left: 260,
      toJSON: () => ({}),
    } as DOMRect);
    expect(editor).toBeTruthy();
    expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("760px");

    fireEvent.pointerDown(editor!, { button: 0, pointerType: "mouse", clientX: 918, clientY: 200 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 862, clientY: 200 });

    expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("760px");
  });

  it("restores the PDF preview after hiding it", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));
    expect(container.querySelector(".typeset-preview-stack")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide PDF preview" }));
    await waitFor(() => expect(container.querySelector(".typeset-preview-stack")).toBeNull());
    expect(screen.getByRole("button", { name: "Show PDF panel" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show PDF panel" }));
    await waitFor(() => expect(container.querySelector(".typeset-preview-stack")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Hide PDF panel" })).toBeTruthy();
  });

  it("resizes panels from touch drag", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const divider = screen.getByRole("separator", { name: "Resize Project files" });
    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");

    fireEvent.pointerDown(divider, { pointerType: "touch", clientX: 260, clientY: 0 });
    fireEvent.pointerMove(window, { pointerType: "touch", clientX: 316, clientY: 0 });

    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("260px"));

    fireEvent.pointerUp(window, { pointerType: "touch", clientX: 316, clientY: 0 });
  });
});
