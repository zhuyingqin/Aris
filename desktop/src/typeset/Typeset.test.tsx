// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Typeset from "./Typeset";
import { useStore } from "../store";

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

vi.mock("../api/tauri", () => ({
  configSet: mocks.configSet,
  fileCreateText: mocks.fileCreateText,
  fileListDir: mocks.fileListDir,
  fileOpen: mocks.fileOpen,
  fileReadBytes: mocks.fileReadBytes,
  fileReadText: mocks.fileReadText,
  fileSearch: mocks.fileSearch,
  fileWriteText: mocks.fileWriteText,
  isTauri: () => false,
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
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));

    // Opening a source auto-compiles it (same target as Recompile), so we assert
    // on that compile rather than clicking Recompile manually.
    await waitFor(() => expect(mocks.latexCompile).toHaveBeenCalledWith("sections/local.tex", "sections/local.pdf"));
    expect(container.querySelector(".typeset-visual-filebar strong")?.textContent).toBe("local.tex");
    await waitFor(() => expect(container.querySelector(".typeset-preview-file")?.textContent).toBe("main.pdf"));
  });

  it("edits a heading directly in visual mode and syncs it back to source", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "sections/local.tex",
      content: "\\documentclass{article}\n\\begin{document}\n\\section{Local}\nBody text\n\\end{document}",
      bytes: 80,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const heading = await waitFor(() => {
      const item = container.querySelector<HTMLInputElement>(".typeset-visual-block.heading input");
      expect(item?.value).toBe("Local");
      return item!;
    });
    fireEvent.change(heading, { target: { value: "Edited title" } });

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() =>
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\section{Edited title}"),
    );
  });

  it("renders LaTeX visual mode from document body instead of preamble commands", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: [
        "% USTMS recommendation guide",
        "\\documentclass[11pt,a4paper]{article}",
        "\\usepackage{fontspec}",
        "\\usepackage{xeCJK}",
        "\\title{USTMS Guide}",
        "\\author{ARIS recommendation engine}",
        "\\date{2026-07-02}",
        "\\begin{document}",
        "\\maketitle",
        "\\begin{abstract}",
        "This guide summarizes Scopus evidence.",
        "\\end{abstract}",
        "\\section{Introduction}",
        "Visual mode should show body content.",
        "\\begin{itemize}",
        "\\item First point",
        "\\item Second point",
        "\\end{itemize}",
        "\\end{document}",
      ].join("\n"),
      bytes: 360,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    expect(await screen.findByRole("button", { name: /Show document preamble/i })).toBeTruthy();
    expect(screen.queryByDisplayValue(/\\documentclass/)).toBeNull();
    expect(screen.queryByDisplayValue(/\\usepackage/)).toBeNull();
    expect(screen.getByDisplayValue("USTMS Guide")).toBeTruthy();
    expect(screen.getByDisplayValue("This guide summarizes Scopus evidence.")).toBeTruthy();
    expect(screen.getByDisplayValue("Introduction")).toBeTruthy();

    const heading = container.querySelector<HTMLInputElement>(".typeset-visual-block.heading input");
    expect(heading?.value).toBe("Introduction");
    fireEvent.change(heading!, { target: { value: "Edited intro" } });
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() =>
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\section{Edited intro}"),
    );
  });

  it("renders and edits multiline LaTeX title metadata as clean visual text", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: [
        "\\documentclass{article}",
        "\\usepackage{xcolor}",
        "\\title{\\vspace{-1.0cm}\\Huge\\bfseries\\color{primary}",
        "Submission Guide}",
        "\\author{USTMS Lab}",
        "\\date{2026-07-04}",
        "\\begin{document}",
        "\\maketitle",
        "\\section{Overview}",
        "Body text.",
        "\\end{document}",
      ].join("\n"),
      bytes: 260,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    const title = (await screen.findByLabelText("Edit document title")) as HTMLTextAreaElement;
    expect(title.value).toBe("Submission Guide");
    fireEvent.change(title, { target: { value: "Edited Guide" } });
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() => {
      const value = container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value ?? "";
      expect(value).toContain("\\title{Edited Guide}");
      expect(value).not.toContain("Submission Guide}");
    });
  });

  it("renders Beamer frames as editable slide blocks while preserving frame options", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: [
        "\\documentclass[aspectratio=169]{beamer}",
        "\\begin{document}",
        "\\begin{frame}[fragile]{Pipeline}",
        "\\begin{itemize}",
        "\\item Load source",
        "\\item Render visual editor",
        "\\end{itemize}",
        "\\end{frame}",
        "\\end{document}",
      ].join("\n"),
      bytes: 220,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    expect(container.querySelector(".typeset-visual-page.beamer-deck")).toBeTruthy();
    expect(container.querySelector(".typeset-visual-block.frame")).toBeTruthy();
    const slideTitle = (await screen.findByLabelText(/Edit slide title at line/i)) as HTMLInputElement;
    expect(slideTitle.value).toBe("Pipeline");

    fireEvent.change(screen.getByLabelText(/Edit slide body at line/i), { target: { value: "Edited slide body." } });
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() =>
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain(
        "\\begin{frame}[fragile]{Pipeline}\nEdited slide body.\n\\end{frame}",
      ),
    );
  });

  it("parses common Beamer slide templates without showing drawing noise", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "slides/main.tex",
      content: [
        "\\documentclass{beamer}",
        "\\begin{document}",
        "\\begin{frame}{Motivation}",
        "\\secbar{1}{5}{问题与动机}",
        "\\begin{columns}",
        "\\column{0.5\\textwidth}",
        "\\begin{alertblock}{现实困境：奖励函数很难写}",
        "\\begin{itemize}",
        "\\item 自动驾驶：撞车 $-100$，变道 $-1$",
        "\\item 推荐系统：短期点击 vs 长期满意度？",
        "\\end{itemize}",
        "\\end{alertblock}",
        "\\column{0.48\\textwidth}",
        "\\begin{exampleblock}{但行为数据大量存在}",
        "\\begin{itemize}",
        "\\item 人类司机每天 \\gd{数百万条}轨迹",
        "\\item LLM 阅读 1T+ token 文本",
        "\\end{itemize}",
        "\\end{exampleblock}",
        "\\begin{tcolorbox}[colback=primary!8,",
        "  arc=3pt, boxsep=2pt, title={反推奖励}]",
        "\\\\",
        "能否从示范反推奖励？",
        "\\end{tcolorbox}",
        "\\bd{病态反问题}",
        "};",
        "\\begin{tabular}{@{}p{1.3cm}@{\\hspace{0.15cm}}p{1.4cm}@{}}",
        "\\toprule",
        "\\textbf{维度} & \\textbf{IRL} \\\\",
        "奖励来源 & \\gd{从示范推断} \\\\",
        "\\bottomrule",
        "\\end{tabular}",
        "\\end{columns}",
        "\\begin{tikzpicture}",
        "\\node[sec] (s1) {动机};",
        "\\draw[arr] (s1)--(s2);",
        "\\end{tikzpicture}",
        "\\note{首先问大家一个问题：你们有没有被奖励函数设计折磨过？}",
        "\\end{frame}",
        "\\end{document}",
      ].join("\n"),
      bytes: 600,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("local.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("sections/local.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    expect(await screen.findByDisplayValue("Motivation")).toBeTruthy();
    expect(screen.getByText("问题与动机")).toBeTruthy();
    expect(screen.getByText("现实困境：奖励函数很难写")).toBeTruthy();
    expect(screen.getByText("但行为数据大量存在")).toBeTruthy();
    expect(screen.getByText("能否从示范反推奖励？")).toBeTruthy();
    expect(screen.getByText("病态反问题")).toBeTruthy();
    expect(screen.getByText("维度")).toBeTruthy();
    expect(screen.getByText("从示范推断")).toBeTruthy();
    const preview = container.querySelector<HTMLElement>(".typeset-visual-slide-preview");
    expect(preview).toBeTruthy();
    const formula = preview!.querySelector<HTMLElement>(".typeset-visual-formula");
    expect(formula).toBeTruthy();
    const sourceDetails = container.querySelector<HTMLDetailsElement>(".typeset-visual-frame-source");
    expect(sourceDetails?.open).toBe(false);
    fireEvent.click(formula!);
    const formulaEditor = await screen.findByLabelText(/Edit formula at line/i);
    expect(sourceDetails?.open).toBe(false);
    expect(document.activeElement).toBe(formulaEditor);
    fireEvent.change(formulaEditor, { target: { value: "-200" } });
    fireEvent.blur(formulaEditor);
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() =>
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("撞车 $-200$"),
    );
    expect(within(preview!).getByText(/首先问大家一个问题/).className).toContain("typeset-visual-slide-note");
    expect(preview!.textContent).not.toContain("node[sec]");
    expect(preview!.textContent).not.toContain("draw[arr]");
    expect(preview!.textContent).not.toContain("colback=primary");
    expect(preview!.textContent).not.toContain("p{1.3cm}");
    expect(preview!.textContent).not.toContain("arc=3pt");
    expect(preview!.textContent).not.toContain("boxsep=2pt");
    expect(preview!.textContent).not.toContain("\\\\");
    expect(preview!.textContent).not.toContain("\\bd{");
    expect(preview!.textContent).not.toContain("};");
  });

  it("edits LaTeX visual figure table theorem citation and footnote widgets", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\section{Results}",
        "\\begin{figure}[h]",
        "\\centering",
        "\\includegraphics[width=.8\\linewidth]{figures/visual-editor.svg}",
        "\\caption{Initial visual architecture.}",
        "\\end{figure}",
        "\\begin{table}[h]",
        "\\centering",
        "\\begin{tabular}{ll}",
        "Metric & Value \\\\",
        "MAE & 1.0 \\\\",
        "\\end{tabular}",
        "\\end{table}",
        "\\begin{theorem}[Bound]",
        "Initial theorem.",
        "\\end{theorem}",
        "\\cite{oldkey}",
        "\\footnote{Initial note.}",
        "\\end{document}",
      ].join("\n"),
      bytes: 260,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    fireEvent.change(await screen.findByLabelText(/Edit figure caption at line/i), { target: { value: "Edited visual architecture." } });
    const tableCell = await screen.findByLabelText(/Edit table cell 1, 1/i);
    fireEvent.change(tableCell, { target: { value: "RMSE" } });
    // Theorems now render typeset (like Overleaf); click to enter source editing.
    fireEvent.click(screen.getByLabelText(/theorem at line .*Activate to edit/i));
    fireEvent.change(await screen.findByLabelText(/Edit theorem at line/i), { target: { value: "Edited theorem." } });
    fireEvent.change(screen.getByLabelText(/Edit citation keys at line/i), { target: { value: "smith2026, doe2025" } });
    fireEvent.change(screen.getByLabelText(/Edit footnote at line/i), { target: { value: "Edited note." } });

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() => {
      const value = container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value ?? "";
      expect(value).toContain("\\includegraphics[width=.8\\linewidth]{figures/visual-editor.svg}");
      expect(value).toContain("\\caption{Edited visual architecture.}");
      expect(value).toContain("RMSE & 1.0");
      expect(value).toContain("\\begin{theorem}[Bound]\nEdited theorem.\n\\end{theorem}");
      expect(value).toContain("\\cite{smith2026,doe2025}");
      expect(value).toContain("\\footnote{Edited note.}");
    });
  });

  it("renders custom entry macros as editable visual blocks instead of raw commands", async () => {
    mockProjectFiles();
    mocks.fileReadText.mockResolvedValueOnce({
      path: "paper.tex",
      content: [
        "\\entrymeta{IEEE Transactions on Smart Grid \\quad 2020 \\quad CAS-Q1 \\quad citations: 397 \\quad DOI: \\texttt{10.1109/TSG.2019.2933191}}",
        "",
        "\\entryauthors{Authors: Huang Q.; Huang R.; Hao W.}",
        "",
        "\\entrymeta{Affiliations: Pacific Northwest National Laboratory; Pratt School of Engineering; Google LLC}",
        "",
        "\\entrykeywords{Deep reinforcement learning, dynamic braking, emergency control}",
        "",
        "\\entryabstract{[EN] Power system emergency control is generally regarded as the last safety net for grid security and resiliency.}",
        "",
        "\\entryabstract{[CN] 本文针对强化学习问题开展研究。}",
      ].join("\n"),
      bytes: 360,
    });

    const { container } = render(<Typeset />);

    fireEvent.click(await screen.findByText("paper.tex"));
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));

    expect(await screen.findByText("Meta")).toBeTruthy();
    expect(screen.getByText("Authors")).toBeTruthy();
    expect(screen.getByText("Affiliations")).toBeTruthy();
    expect(screen.getByText("Keywords")).toBeTruthy();
    expect(screen.getAllByText("Abstract")).toHaveLength(2);
    expect(screen.getByText("EN")).toBeTruthy();
    expect(screen.getByText("CN")).toBeTruthy();
    expect(container.querySelector(".typeset-visual-block.command")).toBeNull();
    expect(screen.queryByDisplayValue(/\\entryabstract/)).toBeNull();
    expect(screen.queryByDisplayValue(/\\entrymeta/)).toBeNull();

    const metaField = screen.getByLabelText(/Edit Meta at line 1/i) as HTMLTextAreaElement;
    expect(metaField.value).toContain("DOI: 10.1109/TSG.2019.2933191");
    expect(metaField.value).not.toContain("\\quad");
    expect(metaField.value).not.toContain("\\texttt");

    fireEvent.change(screen.getByLabelText(/Edit Abstract at line 9/i), { target: { value: "Edited abstract text." } });
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    await waitFor(() =>
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\entryabstract{[EN] Edited abstract text.}"),
    );
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
    expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\textbf{important text}");

    fireEvent.click(undo);
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).not.toContain("\\textbf{important text}");
    });
    expect(redo.disabled).toBe(false);

    fireEvent.click(redo);
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>(".lab-editor-input")?.value).toContain("\\textbf{important text}");
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
        expect.stringContaining("\\textbf{important text}"),
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
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
    // Let the open-time auto-compile (and its PDF refresh) settle first.
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
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
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
    await waitFor(() => expect(mocks.fileReadText).toHaveBeenCalledWith("paper.tex"));
    // Let the open-time auto-compile (and its PDF refresh) settle first.
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
