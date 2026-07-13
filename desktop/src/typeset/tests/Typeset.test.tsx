// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { highlightingFor } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Typeset from "../Typeset";
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
  latexForwardSearch: vi.fn(),
  onLatexCompileProgress: vi.fn(),
  newapiBootstrap: vi.fn(),
  newapiLogin: vi.fn(),
  newapiLogout: vi.fn(),
  newapiRegister: vi.fn(),
  projectAdd: vi.fn(),
  projectsGet: vi.fn(),
  projectsReorder: vi.fn(),
  projectSetCurrent: vi.fn(),
  stateDir: vi.fn(),
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
  latexForwardSearch: mocks.latexForwardSearch,
  onLatexCompileProgress: mocks.onLatexCompileProgress,
  newapiBootstrap: mocks.newapiBootstrap,
  newapiLogin: mocks.newapiLogin,
  newapiLogout: mocks.newapiLogout,
  newapiRegister: mocks.newapiRegister,
  projectAdd: mocks.projectAdd,
  projectsGet: mocks.projectsGet,
  projectsReorder: mocks.projectsReorder,
  projectSetCurrent: mocks.projectSetCurrent,
  stateDir: mocks.stateDir,
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
  window.localStorage.removeItem("somniq-typeset-preview");
  window.localStorage.removeItem("somniq-lab-preview");
  window.localStorage.removeItem("aris-lab-preview");
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
    projects: [project],
    currentProject: project,
    projectBusy: false,
    error: null,
  });
  mocks.fileCreateText.mockReset().mockResolvedValue({ path: "papers/main.tex", content: "", bytes: 0 });
  mocks.fileDelete.mockReset().mockResolvedValue(undefined);
  mocks.fileDuplicate.mockReset().mockResolvedValue({ name: "notes copy.md", path: "sections/notes copy.md", isDir: false });
  mocks.fileOpen.mockReset().mockResolvedValue(undefined);
  mocks.fileReadBytes.mockReset().mockResolvedValue([]);
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
  mocks.fileWriteText.mockReset().mockImplementation((path: string, content: string) => Promise.resolve({ path, content, bytes: content.length }));
  mocks.latexCompile.mockReset().mockResolvedValue({ success: true, outputPath: "paper.pdf" });
  mocks.onLatexCompileProgress.mockReset().mockResolvedValue(() => undefined);
  mocks.latexForwardSearch.mockReset().mockResolvedValue({
    found: true,
    locations: [{ page: 1, pointX: 50, pointY: 60, boxLeft: 40, boxTop: 55, boxWidth: 100, boxHeight: 12 }],
    stderr: "",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Typeset start page", () => {
  function mockProjectFiles() {
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

  it("shows whole-project scan results at root and current-folder contents after entering a folder", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    expect(await screen.findByText("other.tex")).toBeTruthy();
    expect(screen.getByText("paper.tex")).toBeTruthy();
    expect(screen.getByText("local.tex")).toBeTruthy();

    const folderList = container.querySelector<HTMLElement>(".typeset-folder-list");
    expect(folderList).toBeTruthy();
    const sectionsButton = within(folderList!).getByText("sections").closest("button");
    expect(sectionsButton).toBeTruthy();
    fireEvent.click(sectionsButton!);

    await waitFor(() => expect(mocks.fileListDir).toHaveBeenCalledWith("sections"));
    await waitFor(() => expect(screen.queryByText("other.tex")).toBeNull());
    expect(screen.queryByText("paper.tex")).toBeNull();
    expect(screen.getByText("local.tex")).toBeTruthy();
    expect(within(folderList!).getByText("nested")).toBeTruthy();
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

    expect(await screen.findByText("Folders")).toBeTruthy();
    expect(screen.getByText("Sources")).toBeTruthy();
    expect(screen.queryByText("Open LaTeX source")).toBeNull();
    expect(screen.getByText("other.tex")).toBeTruthy();
    expect(screen.getByText("paper.tex")).toBeTruthy();
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
      expect(mocks.latexCompile).toHaveBeenCalledWith("paper.tex", "paper.pdf", true, expect.any(String)),
    );
  });

  it("renders the compile options control with an SVG icon", async () => {
    mockProjectFiles();
    render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Compile options" })).toBeTruthy());

    expect(screen.getByRole("button", { name: "Compile options" }).querySelector("svg")).toBeTruthy();
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
    const deck = within(compiledVisual).getByRole("navigation", { name: "Slide deck outline" });
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
    expect(within(compiledVisual).queryByRole("navigation", { name: "Slide deck outline" })).toBeNull();
    fireEvent.click(within(compiledVisual).getByRole("button", { name: "Show slide list" }));
    expect(within(compiledVisual).getByRole("navigation", { name: "Slide deck outline" })).toBeTruthy();

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

  it("clicking the rendered title jumps to Code mode with the \\title{} source selected", async () => {
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
    fireEvent.click(titleEl);

    await waitFor(() => expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => {
      const view = typesetCodeView();
      expect(view).toBeTruthy();
      const { from, to } = view!.state.selection.main;
      expect(view!.state.doc.toString().slice(from, to)).toBe("My Paper Title");
    });
  });

  it("clicking the rendered author jumps to Code mode with the \\author{} source selected", async () => {
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
    fireEvent.click(authorEl);

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
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledTimes(1));
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
      expect(view?.state.selection.main.to).toBe(expectedStart + "Body text".length);
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

    const outline = screen.getByLabelText("Document outline");
    fireEvent.click(within(outline).getByRole("button", { name: /Method/ }));

    const expectedOffset = source.indexOf("\\section{Method}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => {
      const { from, to } = typesetCodeView()?.state.selection.main ?? { from: -1, to: -1 };
      expect(from).toBe(expectedOffset);
      expect(to).toBe(expectedOffset);
    });
    expect(container.querySelector<HTMLElement>(".typeset-current-section")?.textContent).toContain("Section 2 Method");
    expect(within(outline).getByRole("button", { name: /Method/ }).getAttribute("aria-current")).toBe("location");
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
    const divider = screen.getByRole("separator", { name: "Resize Outline" });
    expect(outline?.style.flexBasis).toBe("184px");

    fireEvent.pointerDown(divider, { button: 0, pointerType: "mouse", clientY: 300 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientY: 240 });

    await waitFor(() => expect(outline?.style.flexBasis).toBe("244px"));

    fireEvent.pointerUp(window, { pointerType: "mouse", clientY: 240 });
    fireEvent.click(screen.getByRole("button", { name: "Hide Outline" }));

    await waitFor(() => expect(container.querySelector(".typeset-outline")).toBeNull());
    expect(screen.getByRole("button", { name: /Outline/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Outline/ }));
    await waitFor(() => expect(container.querySelector<HTMLElement>(".typeset-outline")?.style.flexBasis).toBe("244px"));
  });

  it("keeps resizing panels after the mouse leaves the divider", async () => {
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

  it("starts resizing from the wider project edge hit zone", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const projectPanel = container.querySelector<HTMLElement>(".typeset-left-panel");
    const divider = screen.getByRole("separator", { name: "Resize Project files" });
    vi.spyOn(divider, "getBoundingClientRect").mockReturnValue({
      x: 244,
      y: 76,
      width: 14,
      height: 644,
      top: 76,
      right: 258,
      bottom: 720,
      left: 244,
      toJSON: () => ({}),
    } as DOMRect);
    expect(projectPanel).toBeTruthy();
    expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("204px");

    fireEvent.pointerDown(projectPanel!, { button: 0, pointerType: "mouse", clientX: 230, clientY: 200 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 286, clientY: 200 });

    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-left-user-w")).toBe("260px"));

    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 286, clientY: 200 });
  });

  it("starts resizing from the wider PDF edge hit zone", async () => {
    mockProjectFiles();

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    const grid = container.querySelector<HTMLElement>(".typeset-main-grid");
    const preview = container.querySelector<HTMLElement>(".typeset-preview-stack");
    const divider = screen.getByRole("separator", { name: "Resize PDF preview" });
    vi.spyOn(divider, "getBoundingClientRect").mockReturnValue({
      x: 930,
      y: 76,
      width: 14,
      height: 644,
      top: 76,
      right: 944,
      bottom: 720,
      left: 930,
      toJSON: () => ({}),
    } as DOMRect);
    expect(preview).toBeTruthy();
    expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("760px");

    fireEvent.pointerDown(preview!, { button: 0, pointerType: "mouse", clientX: 958, clientY: 200 });
    fireEvent.pointerMove(window, { buttons: 1, pointerType: "mouse", clientX: 902, clientY: 200 });

    await waitFor(() => expect(grid?.style.getPropertyValue("--typeset-preview-user-w")).toBe("816px"));

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
    const divider = screen.getByRole("separator", { name: "Resize PDF preview" });
    vi.spyOn(divider, "getBoundingClientRect").mockReturnValue({
      x: 930,
      y: 76,
      width: 14,
      height: 644,
      top: 76,
      right: 944,
      bottom: 720,
      left: 930,
      toJSON: () => ({}),
    } as DOMRect);
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
