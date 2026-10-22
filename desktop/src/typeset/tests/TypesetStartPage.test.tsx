// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypesetDocument, TypesetProject } from "../../api/tauri";
import { useStore } from "../../store";
import TypesetStartPage from "../TypesetStartPage";

const mocks = vi.hoisted(() => ({ fileReveal: vi.fn() }));
vi.mock("../../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tauri")>()),
  fileReveal: mocks.fileReveal,
}));

const documents: TypesetDocument[] = [
  { path: "papers/main.tex", projectPath: "papers", title: "Overview", kind: "article", modifiedEpochMs: 100, compileState: "fresh" },
  { path: "papers/study-a/main.tex", projectPath: "papers", title: "Study A", kind: "article", modifiedEpochMs: 200, compileState: "missing" },
  { path: "papers/study-b/main.tex", projectPath: "papers", title: "Study B", kind: "report", modifiedEpochMs: 300, compileState: "stale" },
  { path: "papers/study-b/revisions/draft.tex", projectPath: "papers", title: "Earlier draft", kind: "report", modifiedEpochMs: 400, compileState: "missing" },
];
const projects: TypesetProject[] = [
  { path: "papers", name: "papers", texFileCount: 32, modifiedEpochMs: 400 },
];
const props = () => ({
  projectPath: "F:/research", documents, projects, latexAvailable: true,
  loading: false, error: null, onOpenSource: vi.fn(), onCreateSource: vi.fn(), onRefresh: vi.fn(),
});
const toggle = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const search = (value: string) => fireEvent.change(screen.getByPlaceholderText("Search by title or path"), { target: { value } });

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ language: "en" });
  mocks.fileReveal.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("LaTeX library folder browsing", () => {
  it("shows real subfolders one level at a time without flattening nested documents", () => {
    render(<TypesetStartPage {...props()} />);
    expect(screen.queryByText("Study A")).toBeNull();
    expect(screen.queryByText("study-a", { exact: true })).toBeNull();
    toggle("Expand papers project");
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand study-a folder" })).toBeTruthy();
    expect(screen.queryByText("Study A")).toBeNull();
    toggle("Expand study-b folder");
    expect(screen.getByText("Study B")).toBeTruthy();
    expect(screen.queryByText("Earlier draft")).toBeNull();
    toggle("Expand revisions folder");
    expect(screen.getByText("Earlier draft")).toBeTruthy();
    expect(screen.getAllByText(/32 \.tex files/)).toHaveLength(1);
    expect(screen.getByText("1 project · 4 root documents")).toBeTruthy();
  });

  it("opens the project's direct main file and a nested folder's own main file", () => {
    const callbacks = props();
    render(<TypesetStartPage {...callbacks} />);
    toggle("Open papers project");
    expect(callbacks.onOpenSource).toHaveBeenLastCalledWith("papers/main.tex");
    toggle("Expand papers project");
    toggle("Open main document in study-b");
    expect(callbacks.onOpenSource).toHaveBeenLastCalledWith("papers/study-b/main.tex");
    toggle("Expand study-b folder");
    toggle("Open Study B");
    expect(callbacks.onOpenSource).toHaveBeenLastCalledWith("papers/study-b/main.tex");
  });

  it("remembers expanded folders across returning to the library and switching workspaces", () => {
    const callbacks = props();
    const view = render(<TypesetStartPage {...callbacks} />);
    toggle("Expand papers project");
    toggle("Expand study-b folder");
    view.unmount();
    const reopened = render(<TypesetStartPage {...callbacks} />);
    expect(screen.getByText("Study B")).toBeTruthy();
    reopened.rerender(<TypesetStartPage {...callbacks} projectPath="F:/another-workspace" />);
    expect(screen.queryByText("Study B")).toBeNull();
    reopened.rerender(<TypesetStartPage {...callbacks} />);
    expect(screen.getByText("Study B")).toBeTruthy();
    toggle("Collapse papers project");
    expect(JSON.parse(window.localStorage.getItem("somniq-typeset-library-folders:F:/research")!).papers).toBe(false);
  });

  it("reveals the full matching folder path during search and restores normal browsing after clearing it", () => {
    render(<TypesetStartPage {...props()} />);
    search("Earlier draft");
    expect(screen.getByText("Earlier draft")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse revisions folder" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /study-a folder/ })).toBeNull();
    toggle("Collapse study-b folder");
    expect(screen.queryByText("Earlier draft")).toBeNull();
    search("study-a");
    expect(screen.getByText("Study A")).toBeTruthy();
    search("");
    expect(screen.getByRole("button", { name: "Expand papers project" })).toBeTruthy();
    expect(screen.queryByText("Study A")).toBeNull();
  });

  it("expands and collapses all folders and selects only documents actually shown", () => {
    render(<TypesetStartPage {...props()} />);
    const all = screen.getByRole("checkbox", { name: "Select visible documents" }) as HTMLInputElement;
    expect(all.disabled).toBe(true);
    toggle("Expand papers project");
    fireEvent.click(all);
    expect((screen.getByRole("checkbox", { name: "Select Overview" }) as HTMLInputElement).checked).toBe(true);
    toggle("Expand all folders");
    expect(screen.getByText("Earlier draft")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select Study A" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(all);
    expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    toggle("Collapse all folders");
    expect(screen.queryByText("Overview")).toBeNull();
    expect(all.disabled).toBe(true);
  });

  it("keeps file actions and category, favorites and archive filters inside their folders", () => {
    const callbacks = props();
    render(<TypesetStartPage {...callbacks} />);
    search("Study B");
    toggle("Show Study B in folder");
    expect(mocks.fileReveal).toHaveBeenCalledWith("papers/study-b/main.tex");
    toggle("Add Study B to favorites");
    search("");
    toggle("Favorites");
    toggle("Expand all folders");
    expect(screen.getByText("Study B")).toBeTruthy();
    expect(screen.queryByText("Study A")).toBeNull();
    toggle("Archive Study B");
    expect(screen.queryByRole("button", { name: /papers project/ })).toBeNull();
    toggle("Archived");
    expect(screen.getByText("Study B")).toBeTruthy();
    toggle("Restore Study B");
    toggle("Reports");
    expect(screen.getByText("Study B")).toBeTruthy();
    expect(screen.queryByText("Overview")).toBeNull();
  });

  it("keeps include-only projects visible without an empty-library warning", () => {
    render(<TypesetStartPage {...props()} documents={[]} projects={[{ path: "chapters", name: "chapters", texFileCount: 12, modifiedEpochMs: 100 }]} />);
    expect(screen.getByText("12 .tex files")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Expand chapters project" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("No LaTeX root documents found")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open chapters project" })).toBeNull();
  });

  it("normalizes Windows paths while preserving the exact path sent to open", () => {
    const callbacks = props();
    const path = "papers\\nested\\main.tex";
    render(<TypesetStartPage {...callbacks} documents={[{ ...documents[0], path }]} />);
    toggle("Expand papers project");
    toggle("Expand nested folder");
    toggle("Open Overview");
    expect(callbacks.onOpenSource).toHaveBeenCalledWith(path);
    expect(screen.getByTitle("papers/nested")).toBeTruthy();
  });

  it("sorts sibling folders naturally and shows loose root documents", () => {
    render(<TypesetStartPage {...props()} documents={[
      { ...documents[0], path: "papers/ch10/main.tex", title: "Chapter ten" },
      { ...documents[0], path: "papers/ch2/main.tex", title: "Chapter two" },
      { ...documents[0], path: "loose.tex", projectPath: "", title: "Loose note" },
    ]} />);
    fireEvent.change(screen.getByLabelText("Sort documents"), { target: { value: "title" } });
    toggle("Expand papers project");
    const names = screen.getAllByRole("button", { name: /Expand ch\d+ folder/ }).map((button) => button.textContent);
    expect(names[0]).toContain("ch2");
    expect(names[1]).toContain("ch10");
    expect(screen.getByText("Loose note")).toBeTruthy();
  });

  it("localizes folder controls and recovers from invalid saved folder state", () => {
    useStore.setState({ language: "cn" });
    window.localStorage.setItem("somniq-typeset-library-folders:F:/research", '{"papers":"false"}');
    render(<TypesetStartPage {...props()} />);
    toggle("展开 papers 项目");
    expect(screen.getByRole("button", { name: "展开 study-a 文件夹" })).toBeTruthy();
    const controls = screen.getByRole("group", { name: "文件夹显示" });
    fireEvent.click(within(controls).getByRole("button", { name: "全部展开" }));
    expect(screen.getByText("Earlier draft")).toBeTruthy();
    toggle("全部收起");
    expect(screen.queryByText("Overview")).toBeNull();
  });
});
