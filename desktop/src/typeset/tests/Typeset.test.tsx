// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { startCompletion } from "@codemirror/autocomplete";
import { highlightingFor } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Typeset from "../Typeset";
import { resetLiteratureStore, useLiteratureStore } from "../../literature/literatureStore";
import { useStore } from "../../store";

const mocks = vi.hoisted(() => ({
  configSet: vi.fn(),
  fileCreateDir: vi.fn(),
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
  latexDocumentContext: vi.fn(),
  latexForwardSearch: vi.fn(),
  latexInverseSearch: vi.fn(),
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
  typesetExportFile: vi.fn(),
  typesetImportFile: vi.fn(),
  typesetListDocuments: vi.fn(),
}));

const pdfMocks = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  type MockTextItem = {
    str: string;
    transform: number[];
    width: number;
    height: number;
    /** pdf.js marks the item that ends a typeset line. */
    hasEOL?: boolean;
  };
  const getTextContent = vi.fn((): Promise<{ items: MockTextItem[] }> => Promise.resolve({
    items: [
      { str: "Body text", transform: [10, 0, 0, 10, 24, 64], width: 48, height: 10 },
    ],
  }));
  const getAnnotations = vi.fn<() => Promise<unknown>>(() => Promise.resolve([]));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 240 * scale,
      height: 120 * scale,
      transform: [scale, 0, 0, -scale, 0, 120 * scale],
      // Mirrors `PageViewport.convertToPdfPoint`: undo the viewport transform
      // back to PDF user space. SyncTeX inverse search goes through it.
      convertToPdfPoint: (x: number, y: number) => [x / scale, (120 * scale - y) / scale],
      convertToViewportRectangle: (rect: number[]) => [rect[0] * scale, (120 - rect[1]) * scale, rect[2] * scale, (120 - rect[3]) * scale],
    }),
    // `PDFPageProxy.view` — the page box, `[x0, y0, x1, y1]` in PDF user space.
    view: [0, 0, 240, 120],
    getTextContent,
    getAnnotations,
    render,
  };
  const document = {
    numPages: 1,
    getPage: vi.fn(() => Promise.resolve(page)),
    getPageIndex: vi.fn(() => Promise.resolve(0)),
    destroy: vi.fn(),
  };
  return {
    document,
    getDocument: vi.fn(() => ({ promise: Promise.resolve(document) })),
    getAnnotations,
    getTextContent,
    getPageIndex: document.getPageIndex,
    page,
    render,
  };
});

const dialogMocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);

vi.mock("../../api/tauri", () => ({
  configSet: mocks.configSet,
  fileCreateDir: mocks.fileCreateDir,
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
  latexDocumentContext: mocks.latexDocumentContext,
  latexForwardSearch: mocks.latexForwardSearch,
  latexInverseSearch: mocks.latexInverseSearch,
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
  typesetExportFile: mocks.typesetExportFile,
  typesetImportFile: mocks.typesetImportFile,
  typesetListDocuments: mocks.typesetListDocuments,
}));

vi.mock("../../api/browserPreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/browserPreview")>();
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
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:typeset-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
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
  pdfMocks.getAnnotations.mockReset().mockResolvedValue([]);
  pdfMocks.document.getPage.mockReset().mockResolvedValue(pdfMocks.page);
  pdfMocks.getPageIndex.mockReset().mockResolvedValue(0);
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
  mocks.fileCreateDir.mockReset().mockResolvedValue({ path: "chapters", name: "chapters", isDir: true });
  mocks.typesetExportFile.mockReset().mockResolvedValue("C:/exports/paper.pdf");
  mocks.typesetImportFile.mockReset().mockResolvedValue("figures/plot.png");
  dialogMocks.open.mockReset().mockResolvedValue(null);
  dialogMocks.save.mockReset().mockResolvedValue(null);
  window.localStorage.clear();
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
  mocks.latexDocumentContext.mockReset().mockImplementation((sourcePath: string) => Promise.resolve({
    sourcePath,
    rootPath: sourcePath,
    outputPath: sourcePath.replace(/\.tex$/i, ".pdf"),
  }));
  mocks.fileWriteText.mockReset().mockImplementation((path: string, content: string) => Promise.resolve({ path, content, bytes: content.length }));
  mocks.latexCompile.mockReset().mockResolvedValue({ success: true, outputPath: "paper.pdf" });
  mocks.onLatexCompileProgress.mockReset().mockResolvedValue(() => undefined);
  mocks.latexForwardSearch.mockReset().mockResolvedValue({
    found: true,
    locations: [{ page: 1, pointX: 50, pointY: 60, boxLeft: 40, boxTop: 55, boxWidth: 100, boxHeight: 12 }],
    stderr: "",
  });
  mocks.latexInverseSearch.mockReset().mockResolvedValue({ found: false, locations: [], stderr: "" });
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

  // Code mode is now a CodeMirror instance (see desktop/src/editor/CodeEditor.tsx),
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

  it("resolves the root document before showing a directly opened child source", async () => {
    useStore.setState({ pendingTypesetFilePath: "chapters/body.tex" });
    const child = "\\section{Body}\nChild text";
    const root = "\\documentclass{article}\n\\begin{document}\n\\input{chapters/body}\n\\end{document}";
    mocks.latexDocumentContext.mockResolvedValueOnce({
      sourcePath: "chapters/body.tex",
      rootPath: "main.tex",
      outputPath: "main.pdf",
    });
    mocks.fileReadText.mockImplementation((path: string) => {
      if (path === "chapters/body.tex") return Promise.resolve({ path, content: child, bytes: child.length });
      if (path === "main.tex") return Promise.resolve({ path, content: root, bytes: root.length });
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { container } = render(<Typeset />);

    await waitForSourceOpen(container, "chapters/body.tex", "body.tex");
    expect(mocks.latexDocumentContext).toHaveBeenCalledWith("chapters/body.tex");
    await waitFor(() => expect(screen.getByText("main.pdf")).toBeTruthy());
    await waitFor(() => expect(within(screen.getByLabelText("Document outline")).getByRole("button", { name: /Body/ })).toBeTruthy());
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

  it("opens a PNG directly in the image preview with fit and zoom controls", async () => {
    useStore.setState({ pendingTypesetFilePath: "figures/result.png" });
    render(<Typeset />);

    await waitFor(() => expect(mocks.fileReadBytes).toHaveBeenCalledWith("figures/result.png"));
    expect(useStore.getState().pendingTypesetFilePath).toBeNull();
    expect(screen.getByLabelText("Image preview")).toBeTruthy();
    expect(screen.getByText("result.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open image externally" })).toBeTruthy();
  });

  it("returns from an inspected image to the compiled document PDF", async () => {
    const source = "\\documentclass{article}\n\\begin{document}Body\\end{document}";
    useStore.setState({ pendingTypesetFilePath: "paper.tex" });
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexDocumentContext.mockResolvedValueOnce({ sourcePath: "paper.tex", rootPath: "paper.tex", outputPath: "paper.pdf" });
    render(<Typeset />);
    await waitFor(() => expect(screen.getByText("paper.pdf")).toBeTruthy());

    act(() => useStore.setState({ pendingTypesetFilePath: "figures/result.png" }));
    expect(await screen.findByLabelText("Image preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to compiled PDF" }));

    expect(await screen.findByLabelText("PDF preview")).toBeTruthy();
    expect(screen.getByText("paper.pdf")).toBeTruthy();
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

  it("groups root documents under their parent project folder", async () => {
    mockProjectFiles();
    mocks.typesetListDocuments.mockResolvedValue([
      { path: "sections/local.tex", title: "local.tex", kind: "article", modifiedEpochMs: 300, compileState: "fresh" },
      { path: "sections/appendix.tex", title: "appendix.tex", kind: "article", modifiedEpochMs: 250, compileState: "missing" },
      { path: "paper.tex", title: "paper.tex", kind: "article", modifiedEpochMs: 100, compileState: "missing" },
    ]);

    render(<Typeset />);

    expect(await screen.findByRole("button", { name: "Expand sections project" })).toBeTruthy();
    expect(screen.queryByText("local.tex")).toBeNull();
    expect(screen.getByRole("button", { name: "Open sections project" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand sections project" }));
    expect(await screen.findByText("local.tex")).toBeTruthy();
    expect(screen.getByText("appendix.tex")).toBeTruthy();
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

  it("keeps an unsaved draft in its own tab when another tex file is opened", async () => {
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
    const confirm = vi.spyOn(window, "confirm");
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

    // Opening another file no longer asks to discard anything: the first file
    // stays open in its own tab, unsaved edits and all.
    const tree = container.querySelector<HTMLElement>(".typeset-tree");
    fireEvent.click(within(tree!).getByText("other.tex"));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toContain("Other file"));
    expect(confirm).not.toHaveBeenCalled();

    const tabBar = container.querySelector<HTMLElement>(".typeset-visual-filebar")!;
    expect(within(tabBar).getByText("local.tex")).toBeTruthy();
    expect(tabBar.querySelector(".editor-tab.dirty")).toBeTruthy();

    // Switching back restores the draft rather than re-reading the file.
    const readsBefore = mocks.fileReadText.mock.calls.length;
    fireEvent.click(within(tabBar).getByText("local.tex"));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toContain("Unsaved local draft"));
    expect(mocks.fileReadText.mock.calls.slice(readsBefore).flat()).not.toContain("sections/local.tex");
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
    expect(await screen.findByText(/Your unsaved draft was not overwritten/)).toBeTruthy();
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
      null,
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
      null,
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
      expect(mocks.latexCompile).toHaveBeenCalledWith("paper.tex", "paper.pdf", true, expect.any(String), false, null),
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

  it("keeps compiler diagnostics selectable and copyable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: false,
      partialOutput: false,
      pdfState: "missing",
      outputPath: "paper.pdf",
      engine: "latexmk -xelatex",
      stdout: "! Misplaced alignment tab character &.",
      stderr: "",
      interrupted: false,
      timedOut: false,
      durationMs: 21,
      rootSourceHash: "abcdef0123456789",
      diagnostics: [
        { severity: "error", code: "table_alignment", message: "Misplaced alignment tab character &.", filePath: "paper.tex", line: 12 },
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

    // A <button> label cannot be drag-selected, so the message and its source
    // location have to stay ordinary text with a button role bolted on.
    const message = await within(log).findByText("Misplaced alignment tab character &.");
    expect(message.tagName).toBe("SPAN");
    expect(message.closest("button")).toBeNull();
    expect(within(log).getByText("paper.tex, 12").tagName).toBe("SPAN");

    fireEvent.click(within(log).getByRole("button", { name: "Copy this diagnostic" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Misplaced alignment tab character &.");
    expect(copied).toContain("paper.tex, 12");
    await waitFor(() => expect(within(log).getByRole("button", { name: "Copied" })).toBeTruthy());

    fireEvent.click(within(log).getByRole("button", { name: "Copy raw logs" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1][0]).toContain("! Misplaced alignment tab character &.");
    // Copying from the summary must not also toggle the raw-log disclosure.
    expect(log.querySelector<HTMLDetailsElement>(".typeset-raw-logs")?.open).toBe(false);
  });

  it("resolves diagnostic files from the compile root without basename collisions", async () => {
    mockProjectFiles();
    const currentSource = "\\documentclass{article}\n\\begin{document}\nCurrent\n\\end{document}";
    const diagnosticSource = "Nested diagnostic source";
    mocks.fileReadText.mockImplementation((path: string) => {
      if (path === "sections/local.tex") return Promise.resolve({ path, content: currentSource, bytes: currentSource.length });
      if (path === "papers/main.tex") {
        const rootSource = "\\documentclass{article}\n\\begin{document}\n\\input{chapters/local}\n\\end{document}";
        return Promise.resolve({ path, content: rootSource, bytes: rootSource.length });
      }
      if (path === "papers/chapters/local.tex") return Promise.resolve({ path, content: diagnosticSource, bytes: diagnosticSource.length });
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
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

    const pdfLoadsBeforeRecompile = mocks.fileReadBytes.mock.calls
      .filter(([path]) => path === "paper.pdf").length;
    await recompileOpenSource();
    await waitFor(() => expect(mocks.fileReadBytes.mock.calls
      .filter(([path]) => path === "paper.pdf").length).toBeGreaterThan(pdfLoadsBeforeRecompile));
    expect((screen.getByRole("textbox", { name: "Current PDF page" }) as HTMLInputElement).value).toBe("2");
    expect(screen.getByRole("button", { name: "PDF zoom 160%" })).toBeTruthy();
  });

  it("follows internal PDF links such as LaTeX table-of-contents entries", async () => {
    mockProjectFiles();
    pdfMocks.document.numPages = 3;
    pdfMocks.getAnnotations.mockResolvedValue([
      {
        id: "toc-section",
        subtype: "Link",
        rect: [20, 44, 120, 56],
        dest: [{ num: 3, gen: 0 }, { name: "Fit" }],
      },
    ]);
    pdfMocks.getPageIndex.mockResolvedValue(2);
    const source = "\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    await waitFor(() => expect(container.querySelector(".typeset-pdf-link")).toBeTruthy());
    const scroll = container.querySelector<HTMLElement>(".typeset-pdf-scroll");
    const pages = container.querySelectorAll<HTMLElement>(".typeset-pdf-page");
    expect(scroll).toBeTruthy();
    expect(pages).toHaveLength(3);
    pages.forEach((page, index) => {
      Object.defineProperty(page, "offsetTop", { configurable: true, value: index * 160 });
      Object.defineProperty(page, "offsetHeight", { configurable: true, value: 120 });
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scroll!, "scrollTo", { configurable: true, value: scrollTo });

    fireEvent.click(container.querySelector<HTMLButtonElement>(".typeset-pdf-link")!);

    await waitFor(() => expect(pdfMocks.getPageIndex).toHaveBeenCalledWith({ num: 3, gen: 0 }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Current PDF page" }) as HTMLInputElement).value).toBe("3"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 308, behavior: "smooth" });
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
      null,
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
      null,
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

  it("keeps frame source edits local until Ctrl+S writes them and rebuilds the PDF", async () => {
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
    // Saving is what rebuilds: the compile follows the write rather than
    // running on a timer while the author is still typing.
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());
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
    // Path-keyed rather than a call sequence: the editor also reads the .bib
    // files a document declares, to offer their keys in \cite{.
    mocks.fileReadText.mockImplementation((path: string) => (
      path === "paper.tex"
        ? Promise.resolve({ path, content: source, bytes: source.length })
        : Promise.reject(new Error("not found"))
    ));
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
      expect(mocks.fileCreateText).toHaveBeenCalledWith(
        "somniq-references.bib",
        "% SomniQ managed bibliography — do not edit this file directly.\n@article{ada2025citable,}",
      );
      expect(mocks.fileWriteText).not.toHaveBeenCalledWith("references.bib", expect.anything());
    });
  });

  it("adds a managed resource and print command for BibLaTeX without replacing user resources", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\usepackage{biblatex}\n\\addbibresource{references.bib}\n\\addbibresource{appendix.bib}\n\\begin{document}\nFirst.\n\\end{document}";
    // Path-keyed rather than a call sequence: the editor also reads the .bib
    // files a document declares, to offer their keys in \cite{.
    mocks.fileReadText.mockImplementation((path: string) => (
      path === "paper.tex"
        ? Promise.resolve({ path, content: source, bytes: source.length })
        : Promise.reject(new Error("not found"))
    ));
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
      expect(result).toContain("\\addbibresource{appendix.bib}");
      expect(result).toContain("\\addbibresource{somniq-references.bib}");
      expect(result.match(/\\addbibresource\{somniq-references\.bib\}/g)).toHaveLength(1);
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

  it("abandons an in-flight bibliography sync when the source document changes", async () => {
    mockProjectFiles();
    const sourceA = "\\documentclass{article}\n\\begin{document}\nA\n\\bibliographystyle{plain}\n\\bibliography{somniq-references}\n\\end{document}";
    const sourceB = "\\documentclass{article}\n\\begin{document}\nB\n\\end{document}";
    let resolveExport: ((value: { content: string; exported: number }) => void) | undefined;
    mocks.fileReadText.mockImplementation((path: string) => Promise.resolve({
      path,
      content: path === "paper.tex"
        ? sourceA
        : path === "sections/local.tex"
          ? sourceB
          : "% SomniQ managed bibliography — do not edit this file directly.\n",
      bytes: 100,
    }));
    mocks.literatureExportBibliography.mockImplementation(() => new Promise((resolve) => {
      resolveExport = resolve;
    }));

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await waitFor(() => expect(mocks.literatureExportBibliography).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");
    resolveExport?.({ content: "@article{late,}", exported: 1 });

    await act(async () => undefined);
    expect(typesetCodeView()?.state.doc.toString()).toBe(sourceB);
    expect(mocks.fileCreateText).not.toHaveBeenCalledWith(
      "somniq-references.bib",
      expect.stringContaining("@article{late,}"),
    );
    expect(mocks.fileWriteText).not.toHaveBeenCalledWith(
      "somniq-references.bib",
      expect.stringContaining("@article{late,}"),
    );
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

  it("changes a heading level without truncating nested title markup", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\n\\section{Deep \\textbf{learning}}\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });
    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const view = await waitFor(() => {
      const item = typesetCodeView();
      expect(item).toBeTruthy();
      return item!;
    });
    const cursorPos = view.state.doc.toString().indexOf("Deep");
    view.dispatch({ selection: { anchor: cursorPos, head: cursorPos } });

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Section heading" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Subsection" }));

    await waitFor(() => {
      expect(typesetCodeView()?.state.doc.toString()).toContain("\\subsection{Deep \\textbf{learning}}");
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

    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));
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
    // Compile-on-save is the default: the preview is never behind the source
    // after a deliberate save, and never rebuilds mid-sentence either.
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());
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

    const pdfText = await screen.findByRole("button", { name: "Jump to source location on PDF page 1" });
    fireEvent.doubleClick(pdfText);

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

    const pdfText = await screen.findByRole("button", { name: "Jump to source location on PDF page 1" });
    fireEvent.doubleClick(pdfText);

    const expectedStart = source.indexOf("Body text");
    await waitFor(() => {
      const view = (window as unknown as {
        __typesetView?: { state: { selection: { main: { from: number; to: number } } } };
      }).__typesetView;
      expect(container.querySelector(".typeset-editor-pane.visual-mode")).toBeTruthy();
      expect(view?.state.selection.main.from).toBe(expectedStart);
      expect(view?.state.selection.main.to).toBe(expectedStart);
    });
  });

  it("uses inverse SyncTeX to open text from an included source without losing the root PDF", async () => {
    mockProjectFiles();
    const root = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{chapters/body}",
      "\\end{document}",
    ].join("\n");
    const chapter = "\\section{Chapter}\nBody text";
    mocks.fileReadText.mockImplementation((path: string) => {
      if (path === "paper.tex") return Promise.resolve({ path, content: root, bytes: root.length });
      if (path === "chapters/body.tex") return Promise.resolve({ path, content: chapter, bytes: chapter.length });
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });
    mocks.latexInverseSearch.mockResolvedValueOnce({
      found: true,
      locations: [{ sourcePath: "chapters/body.tex", line: 2, column: 3 }],
      stderr: "",
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("chapters/body.tex"));
    await waitFor(() => expect(screen.getByText("paper.pdf")).toBeTruthy());

    const pdfText = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(".typeset-pdf-scroll .typeset-pdf-page-source-target");
      expect(button).toBeTruthy();
      return button!;
    });
    // Coordinates are measured against the rendered page, which is the surface
    // SyncTeX queries are expressed in.
    const pdfPage = pdfText.closest<HTMLElement>(".typeset-pdf-page");
    expect(pdfPage).toBeTruthy();
    vi.spyOn(pdfPage!, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      right: 340,
      bottom: 320,
      width: 240,
      height: 120,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    });
    fireEvent.doubleClick(pdfText, { clientX: 136, clientY: 248 });

    await waitFor(() => expect(mocks.latexInverseSearch).toHaveBeenCalledWith(
      "paper.pdf",
      1,
      48,
      64,
    ));
    await waitForSourceOpen(container, "chapters/body.tex", "body.tex");
    expect(screen.getByText("paper.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(typesetCodeView()?.state.doc.toString()).toBe(chapter));
    // TeX only ever reports `Column:-1`, so the column comes from the word that
    // was actually under the pointer — here the "text" in "Body text", not the
    // start of the line.
    await waitFor(() => expect(typesetCodeView()?.state.selection.main.head).toBe(chapter.indexOf("text")));
  });

  it("remaps a stale SyncTeX line through edits made since the build", async () => {
    // SyncTeX numbers its answer against the source that was compiled. Editing
    // above that line does not invalidate the answer, it shifts it — so the jump
    // still lands on the clicked text instead of degrading to a text search.
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });
    mocks.latexInverseSearch.mockResolvedValue({
      found: true,
      locations: [{ sourcePath: "paper.tex", line: 3, column: null }],
      stderr: "",
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(typesetCodeView()).toBeTruthy());
    const view = typesetCodeView()!;
    // Two lines inserted above the compiled line 3, which now lives on line 5.
    view.dispatch({ changes: { from: 0, insert: "% added\n% also added\n" } });
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());

    const pdfText = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(".typeset-pdf-scroll .typeset-pdf-page-source-target");
      expect(button).toBeTruthy();
      return button!;
    });
    fireEvent.doubleClick(pdfText, { clientX: 20, clientY: 20 });

    await waitFor(() => expect(mocks.latexInverseSearch).toHaveBeenCalled());
    await waitFor(() => {
      const current = typesetCodeView()!;
      expect(current.state.doc.lineAt(current.state.selection.main.head).number).toBe(5);
    });
    expect(await screen.findByText(/adjusted for your edits since/)).toBeTruthy();
  });

  it("runs inverse search from anywhere on the page, not just from a text run", async () => {
    // SyncTeX resolves a coordinate, not a glyph — a display equation, a figure
    // and the white space between two words all have boxes it can answer for.
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });
    mocks.latexInverseSearch.mockResolvedValue({
      found: true,
      locations: [{ sourcePath: "paper.tex", line: 3, column: null }],
      stderr: "",
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());

    const pdfPage = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(".typeset-pdf-scroll .typeset-pdf-page");
      expect(element).toBeTruthy();
      return element!;
    });
    vi.spyOn(pdfPage, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 200, right: 340, bottom: 320, width: 240, height: 120, x: 100, y: 200,
      toJSON: () => ({}),
    });
    // A point in the page margin, well away from the single mocked text run.
    fireEvent.mouseDown(pdfPage, { clientX: 310, clientY: 290 });
    fireEvent.doubleClick(pdfPage, { clientX: 310, clientY: 290 });

    await waitFor(() => expect(mocks.latexInverseSearch).toHaveBeenCalledWith("paper.pdf", 1, 280, 120));
  });

  it("ignores a click that ended somewhere other than where it started", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());

    const pdfPage = container.querySelector<HTMLElement>(".typeset-pdf-scroll .typeset-pdf-page")!;
    fireEvent.mouseDown(pdfPage, { clientX: 20, clientY: 20 });
    fireEvent.doubleClick(pdfPage, { clientX: 20, clientY: 140 });

    expect(mocks.latexInverseSearch).not.toHaveBeenCalled();
  });

  it("shows the SyncTeX diagnostic when reverse search fails", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nDifferent source text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });
    mocks.latexInverseSearch.mockRejectedValueOnce(new Error("SyncTeX: synchronization file is missing"));

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());
    const pdfText = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(".typeset-pdf-scroll .typeset-pdf-page-source-target");
      expect(button).toBeTruthy();
      return button!;
    });
    fireEvent.doubleClick(pdfText, { clientX: 20, clientY: 20 });

    expect(await screen.findByText(/SyncTeX: synchronization file is missing/)).toBeTruthy();
  });

  it("leaves a single click on the PDF to the reader and keeps the keyboard in the pane", async () => {
    // Overleaf, SumatraPDF and TeXstudio all reserve the single click for
    // reading — selecting text, and keeping the arrow keys on the page turner.
    // If it jumped, focus would land in the source editor (a contenteditable),
    // where ArrowLeft/ArrowRight move the caret instead of turning the page.
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());

    const pdfPage = await screen.findByRole("button", { name: "Jump to source location on PDF page 1" });
    fireEvent.mouseDown(pdfPage, { clientX: 28, clientY: 52 });
    fireEvent.click(pdfPage, { clientX: 28, clientY: 52, detail: 1 });

    expect(mocks.latexInverseSearch).not.toHaveBeenCalled();
    expect(container.querySelector(".typeset-pdf-scroll")).toBe(document.activeElement);

    // Keyboard activation has no double click to wait for: `detail === 0`
    // marks a click synthesized from Enter or Space, and that still jumps.
    fireEvent.click(pdfPage, { detail: 0 });
    await waitFor(() => expect(mocks.latexInverseSearch).toHaveBeenCalled());
  });

  it("keeps the per-word text layer in the read-only PDF preview", async () => {
    // The hover highlight and text selection are properties of the per-run
    // elements. A page-wide SyncTeX click target can replace them for
    // *navigation*, but it leaves a reader with no way to point at one word —
    // so the layer has to render outside slide-edit mode too.
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());

    const run = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(".typeset-pdf-scroll .typeset-pdf-text-run");
      expect(element).toBeTruthy();
      return element!;
    });
    // A span, not a button: a control would take focus from the pane on every
    // click and its text could not be dragged over.
    expect(run.tagName).toBe("SPAN");
    expect(run.textContent).toBe("Body text");
    // Sized by its own text and squeezed onto the glyphs with `scaleX`. Forcing
    // the box to the run's width instead puts the selection rectangle beside
    // the words, because the browser draws it around the text, not the box.
    expect(run.style.width).toBe("");
    expect(run.style.left).toBe("18px");
    expect(container.querySelector(".typeset-pdf-scroll .typeset-pdf-text-layer")).toBeTruthy();
  });

  it("closes a tab and falls back to the one beside it", async () => {
    mockProjectFiles();
    const localSource = "\\documentclass{article}\n\\begin{document}\nLocal\n\\end{document}";
    const otherSource = "\\documentclass{article}\n\\begin{document}\nOther file\n\\end{document}";
    mocks.fileListDir.mockResolvedValue([
      { name: "local.tex", path: "sections/local.tex", isDir: false },
      { name: "other.tex", path: "sections/other.tex", isDir: false },
    ]);
    mocks.fileReadText
      .mockResolvedValueOnce({ path: "sections/local.tex", content: localSource, bytes: localSource.length })
      .mockResolvedValueOnce({ path: "sections/other.tex", content: otherSource, bytes: otherSource.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");
    const tree = container.querySelector<HTMLElement>(".typeset-tree")!;
    fireEvent.click(within(tree).getByText("other.tex"));
    await waitForSourceOpen(container, "sections/other.tex");

    const tabBar = container.querySelector<HTMLElement>(".typeset-visual-filebar")!;
    fireEvent.click(within(tabBar).getByRole("button", { name: "Close other.tex" }));

    await waitFor(() => expect(container.querySelector(".typeset-visual-filebar strong")?.textContent).toBe("local.tex"));
    expect(within(tabBar).queryByText("other.tex")).toBeNull();
  });

  it("compiles with the engine chosen in the compile menu instead of the detected one", async () => {
    // Detection reads `% !TeX program` and the preamble's packages, which is
    // right often enough to be the default and wrong often enough — a Chinese
    // paper that needs xelatex — to need an override that sticks.
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("button", { name: "Compile options" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /xelatex/ }));
    await recompileOpenSource();

    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith(
      "paper.tex",
      "paper.pdf",
      false,
      expect.any(String),
      false,
      "xelatex",
    ));
  });

  it("compiles the chosen main document rather than the open file", async () => {
    // A thesis chapter is a fragment; TeX has to be pointed at the root even
    // when the editor is showing something else.
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValue({
      path: "sections/local.tex",
      content: "Chapter body\n",
      bytes: 13,
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("local.tex"));
    await waitForSourceOpen(container, "sections/local.tex");

    const tree = container.querySelector<HTMLElement>(".typeset-tree")!;
    fireEvent.contextMenu(within(tree).getByText("local.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set as main document" }));
    await recompileOpenSource();

    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith(
      "sections/local.tex",
      expect.any(String),
      false,
      expect.any(String),
      false,
      null,
    ));
  });

  it("creates a file from the file tree and opens it", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: "\\documentclass{article}\n", bytes: 24 });
    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    fireEvent.click(within(container.querySelector<HTMLElement>(".file-tree-toolbar")!).getByRole("button", { name: "New file" }));
    const dialog = await screen.findByRole("dialog", { name: "New file" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "chapter.tex" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mocks.fileCreateText).toHaveBeenCalledWith(
      "chapter.tex",
      expect.stringContaining("\\documentclass"),
    ));
  });

  it("imports a file from disk into the project", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: "\\documentclass{article}\n", bytes: 24 });
    dialogMocks.open.mockResolvedValue(["C:/pictures/plot.png"]);
    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    fireEvent.click(within(container.querySelector<HTMLElement>(".file-tree-toolbar")!).getByRole("button", { name: /Import from disk/ }));

    await waitFor(() => expect(mocks.typesetImportFile).toHaveBeenCalledWith("C:/pictures/plot.png", "plot.png"));
  });

  it("saves the compiled PDF to a chosen destination", async () => {
    mockProjectFiles();
    dialogMocks.save.mockResolvedValue("C:/exports/paper.pdf");
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    fireEvent.click(await screen.findByRole("button", { name: /Save the PDF as/ }));

    await waitFor(() => expect(mocks.typesetExportFile).toHaveBeenCalledWith("paper.pdf", "C:/exports/paper.pdf"));
  });

  it("presents the PDF full screen and pages with the arrow keys", async () => {
    mockProjectFiles();
    pdfMocks.document.numPages = 3;
    const source = "\\documentclass{beamer}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    fireEvent.click(await screen.findByRole("button", { name: "Present full screen" }));
    const preview = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(".typeset-preview.pdf.presenting");
      expect(element).toBeTruthy();
      return element!;
    });

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect((screen.getByLabelText("Current PDF page") as HTMLInputElement).value).toBe("2"));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(preview.className).not.toContain("presenting"));
  });

  it("queues rapid PDF page keys without waiting for the current page to render", async () => {
    mockProjectFiles();
    pdfMocks.document.numPages = 5;
    // Keep every canvas render pending to reproduce navigation while the page
    // under the reader is still loading.
    pdfMocks.render.mockReturnValue({ promise: new Promise(() => undefined), cancel: vi.fn() });
    const source = "\\documentclass{beamer}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    fireEvent.click(await screen.findByRole("button", { name: "Present full screen" }));
    await waitFor(() => expect(container.querySelector(".typeset-preview.pdf.presenting")).toBeTruthy());

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });

    expect((screen.getByLabelText("Current PDF page") as HTMLInputElement).value).toBe("4");
  });

  it("keeps a requested PDF page stable during smooth scrolling and lets manual scrolling take over", async () => {
    mockProjectFiles();
    pdfMocks.document.numPages = 3;
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    const pageInput = screen.getByLabelText("Current PDF page") as HTMLInputElement;
    const scroll = container.querySelector<HTMLElement>(".typeset-pdf-scroll");
    const pages = Array.from(container.querySelectorAll<HTMLElement>(".typeset-pdf-page"));
    expect(scroll).toBeTruthy();
    expect(pages).toHaveLength(3);
    Object.defineProperty(scroll!, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scroll!, "scrollTo", { configurable: true, value: vi.fn() });
    pages.forEach((page, index) => {
      Object.defineProperty(page, "offsetTop", { configurable: true, value: index * 160 });
      Object.defineProperty(page, "offsetHeight", { configurable: true, value: 120 });
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(pageInput.value).toBe("3");

    // The animation is crossing pages 1 and 2. Neither scroll event may
    // replace the explicit destination shown in the toolbar.
    scroll!.scrollTop = 40;
    fireEvent.scroll(scroll!);
    expect(pageInput.value).toBe("3");
    scroll!.scrollTop = 160;
    fireEvent.scroll(scroll!);
    expect(pageInput.value).toBe("3");

    // A pointer gesture on the PDF cancels the pending programmatic target;
    // subsequent physical scrolling must once again report the real page.
    fireEvent.pointerDown(scroll!);
    scroll!.scrollTop = 0;
    fireEvent.scroll(scroll!);
    expect(pageInput.value).toBe("1");
  });

  it("inverts the PDF colours from the toolbar", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();

    expect(container.querySelector(".typeset-pdf-scroll.inverted")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Invert PDF colours" }));
    await waitFor(() => expect(container.querySelector(".typeset-pdf-scroll.inverted")).toBeTruthy());
  });

  it("runs inverse search from the toolbar for the top of the current page", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexInverseSearch.mockResolvedValue({
      found: true,
      locations: [{ sourcePath: "paper.tex", line: 3, column: null }],
      stderr: "",
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-page")).toBeTruthy());

    fireEvent.click(await screen.findByRole("button", { name: /Go to the source for the top of this page/ }));

    await waitFor(() => expect(mocks.latexInverseSearch).toHaveBeenCalled());
  });

  it("keeps the spacing and line breaks a copied selection needs", async () => {
    // A PDF text item carries the space that follows it. Trimming each item —
    // right for matching source text — makes a selection spanning two of them
    // copy as "Bodytext", and a selection spanning two lines lose the break.
    mockProjectFiles();
    pdfMocks.getTextContent.mockResolvedValue({
      items: [
        { str: "Body ", transform: [10, 0, 0, 10, 24, 64], width: 30, height: 10, hasEOL: false },
        { str: "text", transform: [10, 0, 0, 10, 60, 64], width: 20, height: 10, hasEOL: true },
        { str: "second line", transform: [10, 0, 0, 10, 24, 50], width: 50, height: 10 },
      ],
    });
    mocks.fileReadText.mockResolvedValue({
      path: "paper.tex",
      content: "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}",
      bytes: 80,
    });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    const layer = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(".typeset-pdf-scroll .typeset-pdf-text-layer");
      expect(element?.textContent).toContain("second line");
      return element!;
    });

    expect(layer.textContent).toContain("Body text");
    expect(layer.querySelectorAll("br")).toHaveLength(1);
  });

  it("points at a recompile when the PDF carries no SyncTeX data", async () => {
    // A PDF built outside Typeset (a skill, or a terminal latexmk without
    // -synctex=1) has no .synctex.gz, and `synctex` reports that in its own
    // words. Surfacing it raw reads like a crash; it is a one-recompile fix.
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}";
    mocks.fileReadText.mockResolvedValue({ path: "paper.tex", content: source, bytes: source.length });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });
    mocks.latexInverseSearch.mockRejectedValueOnce(
      new Error("SyncTeX inverse search failed (exit code 127): No SyncTeX available for paper.pdf"),
    );

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());
    const pdfText = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(".typeset-pdf-scroll .typeset-pdf-page-source-target");
      expect(button).toBeTruthy();
      return button!;
    });
    fireEvent.doubleClick(pdfText, { clientX: 20, clientY: 20 });

    expect(await screen.findByText(/carries no SyncTeX data/)).toBeTruthy();
  });

  it("says so when the jump was guessed from text instead of resolved by SyncTeX", async () => {
    // The text fallback is a guess. Landing silently makes a wrong jump
    // indistinguishable from a right one.
    mockProjectFiles();
    mocks.latexInverseSearch.mockResolvedValue({ found: false, locations: [], stderr: "" });
    mocks.fileReadText.mockResolvedValue({
      path: "paper.tex",
      content: "\\documentclass{article}\n\\begin{document}\nBody text\n\\end{document}",
      bytes: 80,
    });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());
    const pdfPage = await screen.findByRole("button", { name: "Jump to source location on PDF page 1" });
    fireEvent.doubleClick(pdfPage, { clientX: 28, clientY: 52 });

    expect(await screen.findByText(/guessed from the text/)).toBeTruthy();
  });

  it("refuses to guess a source position from a single CJK glyph", async () => {
    // A CJK build subsets one font per handful of glyphs, so pdf.js emits one
    // text item per character. Searching the source for that character alone
    // lands on its first occurrence — confidently in the wrong paragraph.
    mockProjectFiles();
    mocks.latexInverseSearch.mockResolvedValue({ found: false, locations: [], stderr: "" });
    pdfMocks.getTextContent.mockResolvedValue({
      items: [{ str: "模", transform: [10, 0, 0, 10, 24, 64], width: 10, height: 10 }],
    });
    mocks.fileReadText.mockResolvedValue({
      path: "paper.tex",
      content: [
        "\\documentclass{ctexart}",
        "\\begin{document}",
        "早先出现的模型段落",
        "后面真正被点击的模型段落",
        "\\end{document}",
      ].join("\n"),
      bytes: 160,
    });
    mocks.latexCompile.mockResolvedValueOnce({
      success: true,
      inputPath: "paper.tex",
      outputPath: "paper.pdf",
      pdfState: "fresh",
      diagnostics: [],
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    await recompileOpenSource();
    await waitFor(() => expect(container.querySelector(".typeset-pdf-status.success")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(typesetCodeView()).toBeTruthy());
    const pdfPage = await screen.findByRole("button", { name: "Jump to source location on PDF page 1" });
    fireEvent.doubleClick(pdfPage, { clientX: 28, clientY: 52 });

    expect(await screen.findByText(/No source match for this PDF position/)).toBeTruthy();
    expect(typesetCodeView()!.state.selection.main.head).toBe(0);
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

    const pdfText = await screen.findByRole("button", { name: "Jump to source location on PDF page 1" });
    fireEvent.doubleClick(pdfText, { clientX: 28, clientY: 52 });

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
    // The row carries the indent so the fold arrow lines up with its heading.
    const indent = (button: HTMLElement) => parseInt(button.closest<HTMLElement>(".typeset-outline-row")!.style.marginLeft, 10);
    expect(indent(chapter)).toBeLessThan(indent(section));
    expect(indent(section)).toBeLessThan(indent(subsection));
  });

  it("recognizes headings whose title wraps across lines and run-in \\paragraph headings", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section[Short head]{Regime-Conditioned Prediction: One",
      "Predictor, Two Gates}",
      "\\label{sec:gates}",
      "\\paragraph{Data.} Three benchmarks are used.",
      "\\begin{verbatim}",
      "\\section{Not a heading}",
      "\\end{verbatim}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const outline = screen.getByLabelText("Document outline");
    // A wrapped title is read from the whole source, so the heading survives and
    // its two source lines are joined into one outline label.
    const wrapped = within(outline).getByRole("button", { name: /Regime-Conditioned Prediction: One Predictor, Two Gates/ });
    expect(wrapped.getAttribute("data-level")).toBe("1");
    // \paragraph is real structure in a thesis, and nests under its section.
    expect(within(outline).getByRole("button", { name: /Data\./ }).getAttribute("data-level")).toBe("2");
    // Sample LaTeX inside verbatim is not a heading.
    expect(within(outline).queryByRole("button", { name: /Not a heading/ })).toBeNull();
    expect(container.querySelectorAll(".typeset-outline-item")).toHaveLength(2);
  });

  it("lists headings from \\input chapters and opens the included file when one is clicked", async () => {
    mockProjectFiles();
    const root = [
      "\\documentclass{book}",
      "\\begin{document}",
      "\\chapter*{Abstract}",
      "\\mainmatter",
      "\\chapter{Introduction}",
      "\\input{chapters/ch2}",
      "\\input{chapters/missing}",
      "\\end{document}",
    ].join("\n");
    const chapter = [
      "\\chapter{Foundations}",
      "\\section{Reservoir Computing}",
      "\\input{ch2-extra.tex}",
    ].join("\n");
    const nested = "\\section{Echo State Property}";
    mocks.fileReadText.mockImplementation((path: string) => {
      if (path === "paper.tex") return Promise.resolve({ path, content: root, bytes: root.length });
      if (path === "chapters/ch2.tex") return Promise.resolve({ path, content: chapter, bytes: chapter.length });
      if (path === "chapters/ch2-extra.tex") return Promise.resolve({ path, content: nested, bytes: nested.length });
      return Promise.reject(new Error(`no such file: ${path}`));
    });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const outline = screen.getByLabelText("Document outline");
    // The root file of a thesis is a shell: without following \input it would
    // list two chapters and hide the rest of the document.
    const included = await within(outline).findByRole("button", { name: /Foundations/ });
    expect(included.textContent).toContain("ch2.tex");
    // \input targets resolve relative to the including file, and recursively.
    expect(within(outline).getByRole("button", { name: /Echo State Property/ }).textContent).toContain("ch2-extra.tex");
    // An unresolvable target contributes nothing rather than breaking the outline,
    // and included headings sit in document order, numbered as one document.
    const rows = [...container.querySelectorAll(".typeset-outline-item")].map((button) => ({
      // The starred front-matter chapter is unnumbered, exactly as the compiled
      // PDF prints it, so Introduction is Chapter 1 rather than Chapter 2.
      number: button.querySelector("b")?.textContent ?? "",
      title: button.querySelector(".typeset-outline-title")?.textContent ?? "",
      suffix: (button.querySelector("i") ?? button.querySelector("em"))?.textContent ?? "",
    }));
    expect(rows).toEqual([
      { number: "", title: "Abstract", suffix: "3" },
      { number: "1", title: "Introduction", suffix: "5" },
      { number: "2", title: "Foundations", suffix: "ch2.tex" },
      { number: "2.1", title: "Reservoir Computing", suffix: "ch2.tex" },
      { number: "2.2", title: "Echo State Property", suffix: "ch2-extra.tex" },
    ]);

    fireEvent.click(included);
    await waitForSourceOpen(container, "chapters/ch2.tex");
    await waitFor(() => expect(mocks.latexForwardSearch).toHaveBeenCalledWith("chapters/ch2.tex", "paper.pdf", 1, 1));
    expect(screen.getByText("paper.pdf")).toBeTruthy();
    expect(within(screen.getByLabelText("Document outline")).getByRole("button", { name: /Introduction/ })).toBeTruthy();
  });

  it("matches compiler path precedence for nested inputs and import-package sources", async () => {
    mockProjectFiles();
    const root = "\\documentclass{book}\n\\begin{document}\n\\input{chapters/ch1}\n\\end{document}";
    const chapter = "\\chapter{Chapter}\n\\input{sections/method}\n\\import{appendices/}{proof}";
    const rootRelative = "\\section{Root-relative method}";
    const wrongSourceRelative = "\\section{Wrong source-relative method}";
    const imported = "\\section{Imported proof}";
    mocks.fileReadText.mockImplementation((path: string) => {
      const files: Record<string, string> = {
        "main.tex": root,
        "chapters/ch1.tex": chapter,
        "sections/method.tex": rootRelative,
        "chapters/sections/method.tex": wrongSourceRelative,
        "chapters/appendices/proof.tex": imported,
      };
      const content = files[path];
      return content == null
        ? Promise.reject(new Error(`no such file: ${path}`))
        : Promise.resolve({ path, content, bytes: content.length });
    });

    useStore.setState({ pendingTypesetFilePath: "main.tex" });
    mocks.latexDocumentContext.mockResolvedValueOnce({ sourcePath: "main.tex", rootPath: "main.tex", outputPath: "main.pdf" });
    const { container } = render(<Typeset />);
    await waitForSourceOpen(container, "main.tex");

    const outline = screen.getByLabelText("Document outline");
    expect(await within(outline).findByRole("button", { name: /Root-relative method/ })).toBeTruthy();
    expect(within(outline).queryByRole("button", { name: /Wrong source-relative method/ })).toBeNull();
    expect(within(outline).getByRole("button", { name: /Imported proof/ })).toBeTruthy();
  });

  it("suggests LaTeX commands and project citation keys while editing the source", async () => {
    mockProjectFiles();
    useLiteratureStore.setState((state) => ({
      library: {
        ...state.library,
        papers: [{
          ...state.library.papers[0],
          id: "p1",
          title: "Harnessing nonlinearity",
          authors: ["Jaeger"],
          citationKey: "jaeger2004",
          tags: [],
        }],
      },
    }));
    mocks.literatureLoad.mockResolvedValueOnce(useLiteratureStore.getState().library);
    const source = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const view = await waitFor(() => {
      const item = typesetCodeView();
      expect(item).toBeTruthy();
      return item!;
    });

    const typeAt = async (insert: string) => {
      // Let the draft round-trip through React first: the reconciling
      // `setDocument` would otherwise land mid-query and close the popup.
      act(() => {
        const at = view.state.doc.line(4).from;
        view.dispatch({
          changes: { from: at, to: view.state.doc.line(4).to, insert },
          selection: { anchor: at + insert.length },
        });
      });
      await waitFor(() => expect(view.state.doc.line(4).text).toBe(insert));
      act(() => {
        view.focus();
        startCompletion(view);
      });
      return waitFor(() => {
        const options = [...document.querySelectorAll(".cm-tooltip-autocomplete .cm-completionLabel")]
          .map((node) => node.textContent);
        expect(options.length).toBeGreaterThan(0);
        return options;
      });
    };

    // CodeMirror ships no LaTeX language pack, so without our own source there
    // is nothing to suggest at all on a .tex file.
    expect(await typeAt("\\subsec")).toContain("\\subsection");
    // The popup is themed through these class names (editor/completionTheme.css);
    // CodeMirror's own default styling reads as a light-mode browser widget.
    const option = document.querySelector(".cm-tooltip-autocomplete > ul > li");
    expect(option?.querySelector(".cm-completionLabel")).toBeTruthy();
    expect(option?.querySelector(".cm-completionMatchedText")).toBeTruthy();
    expect(option?.querySelector(".cm-completionDetail")).toBeTruthy();
    expect(option?.querySelector(".cm-completionIcon")).toBeTruthy();
    // Citation keys come from the literature library the citation picker uses.
    expect(await typeAt("\\citep{jae")).toContain("jaeger2004");
  });

  it("numbers the outline the way the compiled document does", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{book}",
      "\\begin{document}",
      "\\frontmatter",
      "\\chapter{Preface}",
      "\\mainmatter",
      "\\chapter{Introduction}",
      "\\section{Motivation}",
      "\\paragraph{Data.} Details.",
      "\\chapter{Method}",
      "\\appendix",
      "\\chapter{Proofs}",
      "\\section{Lemma restated}",
      "\\chapter{Datasets}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const rows = [...container.querySelectorAll(".typeset-outline-item")].map((button) => [
      button.querySelector("b")?.textContent ?? "",
      button.querySelector(".typeset-outline-title")?.textContent ?? "",
    ]);
    expect(rows).toEqual([
      // \frontmatter chapters are unnumbered and don't consume a number, so the
      // first \mainmatter chapter is 1; \paragraph is a run-in heading with no
      // number of its own; \appendix restarts the top level at A.
      ["", "Preface"],
      ["1", "Introduction"],
      ["1.1", "Motivation"],
      ["", "Data."],
      ["2", "Method"],
      ["A", "Proofs"],
      ["A.1", "Lemma restated"],
      ["B", "Datasets"],
    ]);
  });

  it("folds a chapter's children, filters headings, and reports the word count", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{report}",
      "\\begin{document}",
      "\\chapter{Foundations}",
      "\\section{Reservoir Computing}",
      "\\section{Echo State Property}",
      "\\chapter{Experiments}",
      "Six plain words of body text here.",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const titles = () => [...container.querySelectorAll(".typeset-outline-item .typeset-outline-title")]
      .map((node) => node.textContent);
    expect(titles()).toEqual(["Foundations", "Reservoir Computing", "Echo State Property", "Experiments"]);

    // Folding hides the sections under the first chapter, not the next chapter.
    fireEvent.click(screen.getAllByRole("button", { name: "Collapse section" })[0]);
    expect(titles()).toEqual(["Foundations", "Experiments"]);
    fireEvent.click(screen.getByRole("button", { name: "Expand section" }));
    expect(titles()).toHaveLength(4);

    // Filtering reaches into folded chapters and matches the number too.
    fireEvent.change(screen.getByLabelText("Filter outline"), { target: { value: "echo" } });
    expect(titles()).toEqual(["Echo State Property"]);
    fireEvent.change(screen.getByLabelText("Filter outline"), { target: { value: "zzz" } });
    expect(screen.getByText("No heading matches.")).toBeTruthy();

    // Body prose only: heading titles are reported separately by texcount
    // and are not part of this figure.
    expect(container.querySelector(".typeset-outline-foot")?.textContent).toBe("7 words");
  });

  it("toggles spell checking on the visual surface only", async () => {
    mockProjectFiles();
    const source = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nBody.\n\\end{document}";
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const visualContent = () => container.querySelector(".typeset-visual-editor-host .cm-content");
    // Off by default: in a .tex every command would otherwise be underlined.
    await waitFor(() => expect(visualContent()?.getAttribute("spellcheck")).toBe("false"));
    fireEvent.click(screen.getByRole("button", { name: "Spell check" }));
    await waitFor(() => expect(visualContent()?.getAttribute("spellcheck")).toBe("true"));
    // Code mode keeps it off whatever the toggle says.
    expect(container.querySelector('[data-editor="typeset-code"]')?.getAttribute("spellcheck")).not.toBe("true");
    expect(window.localStorage.getItem("somniq-typeset-spellcheck")).toBe("on");
  });

  it("numbers parts in Roman and stops at the class's secnumdepth", async () => {
    mockProjectFiles();
    const source = [
      "\\documentclass{report}",
      "\\begin{document}",
      "\\part{Foundations}",
      "\\chapter{Introduction}",
      "\\section{Motivation}",
      "\\subsection{Scope}",
      "\\subsubsection{Detail}",
      "\\part{Applications}",
      "\\chapter{Deployment}",
      "\\end{document}",
    ].join("\n");
    mocks.fileReadText.mockResolvedValueOnce({ path: "paper.tex", content: source, bytes: source.length });

    const { container } = render(<Typeset />);
    fireEvent.click(await screen.findByText("paper.tex"));
    await waitForSourceOpen(container, "paper.tex");

    const rows = [...container.querySelectorAll(".typeset-outline-item")].map((button) => [
      button.querySelector("b")?.textContent ?? "",
      button.querySelector(".typeset-outline-title")?.textContent ?? "",
    ]);
    expect(rows).toEqual([
      // \part is Roman and does not prefix the chapters under it — LaTeX keeps
      // counting chapters straight through Part II. A report's secnumdepth is
      // 2, so \subsubsection carries no number.
      ["I", "Foundations"],
      ["1", "Introduction"],
      ["1.1", "Motivation"],
      ["1.1.1", "Scope"],
      ["", "Detail"],
      ["II", "Applications"],
      ["2", "Deployment"],
    ]);
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
    // outer `.code-editor` wrapper is `overflow: hidden` and no longer scrolls.
    const scroller = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-editor-body .code-editor .cm-scroller");
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
    const editor = container.querySelector<HTMLElement>(".typeset-editor-body .code-editor");
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
