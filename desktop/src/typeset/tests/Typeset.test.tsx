// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Typeset from "../Typeset";
import { useStore } from "../../store";

const mocks = vi.hoisted(() => ({
  configSet: vi.fn(),
  fileCreateText: vi.fn(),
  fileListDir: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  fileReadText: vi.fn(),
  fileSearch: vi.fn(),
  fileWriteText: vi.fn(),
  latexCompile: vi.fn(),
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
  fileListDir: mocks.fileListDir,
  fileOpen: mocks.fileOpen,
  fileReadBytes: mocks.fileReadBytes,
  fileReadText: mocks.fileReadText,
  fileSearch: mocks.fileSearch,
  fileWriteText: mocks.fileWriteText,
  isTauri: () => true,
  latexCompile: mocks.latexCompile,
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
  mocks.fileOpen.mockReset().mockResolvedValue(undefined);
  mocks.fileReadBytes.mockReset().mockResolvedValue([]);
  mocks.fileReadText.mockReset().mockResolvedValue({
    path: "sections/local.tex",
    content: "\\documentclass{article}\n\\begin{document}\n\\section{Local}\nBody text\n\\end{document}",
    bytes: 80,
  });
  mocks.fileWriteText.mockReset().mockImplementation((path: string, content: string) => Promise.resolve({ path, content, bytes: content.length }));
  mocks.latexCompile.mockReset().mockResolvedValue({ success: true, outputPath: "paper.pdf" });
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

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));
    expect(await screen.findByRole("button", { name: "Home" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\section{Local}");

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
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith("sections/local.tex", "sections/local.pdf"));
    expect(container.querySelector(".typeset-visual-filebar strong")?.textContent).toBe("local.tex");
    await waitFor(() => expect(container.querySelector(".typeset-preview-file")?.textContent).toBe("main.pdf"));
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
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\section{Edited title}"),
    );
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
      const ta = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(ta).toBeTruthy();
      expect(ta!.value.slice(ta!.selectionStart ?? 0, ta!.selectionEnd ?? 0)).toBe("My Paper Title");
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
      const ta = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(ta).toBeTruthy();
      expect(ta!.value.slice(ta!.selectionStart ?? 0, ta!.selectionEnd ?? 0)).toBe("Jane Doe");
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
      const ta = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(ta!.value).toContain("Hello \\textbf{world}");
      expect(ta!.value).not.toContain("\\end{document}\\textbf");
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

    const editor = await waitFor(() => {
      const ta = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(ta).toBeTruthy();
      return ta!;
    });
    const from = editor.value.indexOf("Hello");
    editor.setSelectionRange(from, from + "Hello".length);

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Bold" }));

    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\textbf{Hello} world");
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

    const editor = await waitFor(() => {
      const ta = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(ta).toBeTruthy();
      return ta!;
    });
    const cursorPos = editor.value.indexOf("First.") + "First.".length;
    editor.setSelectionRange(cursorPos, cursorPos);

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Insert citation" }));

    await waitFor(() => {
      const ta = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(ta!.value).toBe(`${source.slice(0, cursorPos)}\\cite{reference}${source.slice(cursorPos)}`);
      expect(ta!.value.slice(ta!.selectionStart ?? 0, ta!.selectionEnd ?? 0)).toBe("reference");
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

    const editor = await waitFor(() => {
      const ta = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(ta).toBeTruthy();
      return ta!;
    });
    const cursorPos = editor.value.indexOf("Introduction");
    editor.setSelectionRange(cursorPos, cursorPos);

    const toolbar = container.querySelector<HTMLElement>(".typeset-visual-toolbar");
    fireEvent.click(within(toolbar!).getByRole("button", { name: "Section heading" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Section" }));

    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\section{Introduction}");
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
    expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\textbf{bold text}");

    fireEvent.click(undo);
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).not.toContain("\\textbf{bold text}");
    });
    expect(redo.disabled).toBe(false);

    fireEvent.click(redo);
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\textbf{bold text}");
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

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() =>
      expect(mocks.fileWriteText).toHaveBeenCalledWith(
        "paper.tex",
        expect.stringContaining("\\textbf{bold text}"),
      ),
    );
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
      const editor = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(editor?.selectionStart).toBe(editor?.value.indexOf("Body"));
      expect(editor?.selectionEnd).toBe((editor?.value.indexOf("Body") ?? 0) + "Body".length);
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
      const editor = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      const start = editor?.value.indexOf("Body text") ?? -1;
      expect(editor?.selectionStart).toBe(start);
      expect(editor?.selectionEnd).toBe(start + "Body text".length);
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
      const editor = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      const first = editor?.value.indexOf("Body text") ?? -1;
      const second = editor?.value.indexOf("Body text", first + 1) ?? -1;
      expect(editor?.selectionStart).toBe(second);
      expect(editor?.selectionEnd).toBe(second + "Body text".length);
    });
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
      const editor = container.querySelector<HTMLTextAreaElement>(".lab-editor-input");
      expect(editor?.selectionStart).toBe(expectedOffset);
      expect(editor?.selectionEnd).toBe(expectedOffset);
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

    const scroller = await waitFor(() => {
      const item = container.querySelector<HTMLElement>(".typeset-editor-body .lab-editor");
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
