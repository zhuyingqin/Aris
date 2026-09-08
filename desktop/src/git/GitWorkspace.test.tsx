// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitWorkspaceSnapshot } from "../api/tauri";
import { useStore } from "../store";
import GitWorkspace, { buildReviewDiffRows, parseReviewDiff } from "./GitWorkspace";

const apiMocks = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitInitialize: vi.fn(),
  gitStage: vi.fn(),
  gitUnstage: vi.fn(),
  gitCommit: vi.fn(),
  gitBranchCreate: vi.fn(),
  gitBranchSwitch: vi.fn(),
  gitDiff: vi.fn(),
  localReviewStatus: vi.fn(),
}));

vi.mock("../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tauri")>()),
  ...apiMocks,
}));

const changedSnapshot = (): GitWorkspaceSnapshot => ({
  gitAvailable: true,
  gitVersion: "git version 2.54.0",
  isRepository: true,
  workspacePath: "F:/research",
  repositoryRoot: "F:/research",
  branch: "main",
  detached: false,
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  files: [{
    path: "notes/paper.md",
    oldPath: null,
    indexStatus: null,
    worktreeStatus: "M",
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
  }],
  branches: [
    { name: "main", current: true },
    { name: "review", current: false },
  ],
  hasConflicts: false,
});

const stagedSnapshot = (): GitWorkspaceSnapshot => ({
  ...changedSnapshot(),
  files: [{
    ...changedSnapshot().files[0],
    indexStatus: "M",
    worktreeStatus: null,
    staged: true,
    unstaged: false,
  }],
});

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    language: "en",
    tab: "chat",
    pendingCodeDiff: null,
    currentProject: {
      id: "project-test",
      name: "Research",
      path: "F:/research",
      addedAt: 1,
      lastOpenedAt: 1,
    },
  });
  apiMocks.gitStatus.mockResolvedValue(changedSnapshot());
  apiMocks.gitStage.mockResolvedValue(stagedSnapshot());
  apiMocks.gitUnstage.mockResolvedValue(changedSnapshot());
  apiMocks.gitCommit.mockResolvedValue({ ...changedSnapshot(), files: [] });
  apiMocks.gitBranchCreate.mockResolvedValue(changedSnapshot());
  apiMocks.gitBranchSwitch.mockResolvedValue(changedSnapshot());
  apiMocks.gitDiff.mockResolvedValue({
    path: "notes/paper.md",
    staged: false,
    content: "@@ -1 +1 @@\n-draft\n+evidence\n",
    truncated: false,
  });
  apiMocks.localReviewStatus.mockResolvedValue({
    workspacePath: "F:/research",
    ledgerRoot: "F:/research/.somniq/changes",
    files: [],
    recordCount: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GitWorkspace", () => {
  it("loads once without scheduling background polling", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");

    render(<GitWorkspace embedded />);

    expect(apiMocks.gitStatus).toHaveBeenCalledTimes(1);
    expect(apiMocks.localReviewStatus).toHaveBeenCalledTimes(1);
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it("loads an already-staged change and commits it without Stage controls", async () => {
    apiMocks.gitStatus.mockResolvedValue(stagedSnapshot());
    apiMocks.gitDiff.mockResolvedValue({
      path: "notes/paper.md",
      staged: true,
      content: "@@ -1 +1 @@\n-draft\n+evidence\n",
      truncated: false,
    });
    render(<GitWorkspace />);

    expect(await screen.findByText("paper.md")).toBeTruthy();
    expect(screen.getByText("origin/main · ↑1 ↓0")).toBeTruthy();
    await waitFor(() => expect(apiMocks.gitDiff).toHaveBeenCalledWith("notes/paper.md", true));
    expect(screen.queryByRole("button", { name: "Stage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stage all" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Describe this change…"), {
      target: { value: "Add evidence note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit staged changes" }));
    await waitFor(() => expect(apiMocks.gitCommit).toHaveBeenCalledWith("Add evidence note"));
  });

  it("offers local initialization when the project is not a repository", async () => {
    const notRepository: GitWorkspaceSnapshot = {
      ...changedSnapshot(),
      isRepository: false,
      repositoryRoot: null,
      branch: null,
      upstream: null,
      files: [],
      branches: [],
    };
    apiMocks.gitStatus.mockResolvedValue(notRepository);
    apiMocks.gitInitialize.mockResolvedValue(changedSnapshot());

    render(<GitWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Initialize Git repository" }));
    await waitFor(() => expect(apiMocks.gitInitialize).toHaveBeenCalledOnce());
  });

  it("hands a selected Git diff to the native Code viewer", async () => {
    render(<GitWorkspace />);

    await screen.findByRole("button", { name: "Open Diff in Code" });
    fireEvent.click(screen.getByRole("button", { name: "Open Diff in Code" }));

    expect(useStore.getState().pendingCodeDiff).toEqual({
      path: "F:/research/notes/paper.md",
      staged: false,
    });
    expect(useStore.getState().tab).toBe("lab");
  });

  it("refreshes unchanged review data without reloading the visible diff", async () => {
    render(<GitWorkspace embedded />);

    expect(await screen.findByText("evidence")).toBeTruthy();
    await waitFor(() => expect(apiMocks.gitDiff).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(apiMocks.gitStatus).toHaveBeenCalledTimes(2));
    expect(apiMocks.gitDiff).toHaveBeenCalledTimes(1);
    expect(screen.getByText("evidence")).toBeTruthy();
  });

  it("keeps the embedded Review focused on changed files and the diff", async () => {
    render(<GitWorkspace embedded />);

    expect(await screen.findByText("paper.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Diff in Code" })).toBeTruthy();
    expect(screen.queryByLabelText("Local branches")).toBeNull();
    expect(screen.queryByLabelText("Describe this change…")).toBeNull();
  });

  it("collapses and restores File changes while keeping the code diff visible", async () => {
    const { container } = render(<GitWorkspace embedded />);

    expect(await screen.findByText("evidence")).toBeTruthy();
    const layout = container.querySelector(".git-layout");
    expect(layout?.classList.contains("files-collapsed")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Collapse file changes" }));
    expect(layout?.classList.contains("files-collapsed")).toBe(true);
    expect(screen.getByText("evidence")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand file changes" }));
    expect(layout?.classList.contains("files-collapsed")).toBe(false);
  });

  it("keeps a read-only diff source switch only for a partially staged file", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      files: [{
        ...changedSnapshot().files[0],
        indexStatus: "M",
        worktreeStatus: "M",
        staged: true,
        unstaged: true,
      }],
    });

    render(<GitWorkspace embedded />);

    expect(await screen.findByRole("tab", { name: "Working tree" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Staged" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stage" })).toBeNull();
  });

  it("keeps a readable local ledger review when Git is unavailable", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      gitAvailable: false,
      isRepository: false,
      files: [],
      branches: [],
    });
    apiMocks.localReviewStatus.mockResolvedValue({
      workspacePath: "F:/research",
      ledgerRoot: "F:/research/.somniq/changes",
      recordCount: 1,
      files: [{
        changeId: "chg-local-1",
        path: "notes/paper.md",
        operation: "update",
        status: "applied",
        toolName: "vscode-editor",
        timestamp: "2026-08-28T12:00:00Z",
        beforeExists: true,
        afterExists: true,
        additions: 1,
        deletions: 1,
        unifiedDiff: "--- notes/paper.md\n+++ notes/paper.md\n@@ -1 +1 @@\n-draft\n+evidence\n",
        truncated: false,
        reversible: true,
      }],
    });

    render(<GitWorkspace />);

    expect(await screen.findByText("Local change ledger")).toBeTruthy();
    expect(screen.getByText("paper.md")).toBeTruthy();
    expect(await screen.findByText("evidence")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Commit staged changes" })).toBeNull();
  });

  it("keeps Git initialization available alongside local ledger records", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      isRepository: false,
      repositoryRoot: null,
      branch: null,
      upstream: null,
      files: [],
      branches: [],
    });
    apiMocks.localReviewStatus.mockResolvedValue({
      workspacePath: "F:/research",
      ledgerRoot: "F:/research/.somniq/changes",
      recordCount: 1,
      files: [{
        changeId: "chg-local-2",
        path: "notes/paper.md",
        operation: "update",
        status: "applied",
        toolName: "vscode-editor",
        timestamp: "2026-08-28T12:00:00Z",
        beforeExists: true,
        afterExists: true,
        additions: 1,
        deletions: 1,
        unifiedDiff: "-draft\n+evidence\n",
        truncated: false,
        reversible: true,
      }],
    });
    apiMocks.gitInitialize.mockResolvedValue(changedSnapshot());

    render(<GitWorkspace />);

    fireEvent.click(await screen.findByRole("button", { name: "Initialize Git repository" }));
    await waitFor(() => expect(apiMocks.gitInitialize).toHaveBeenCalledOnce());
  });

  it("shows ledger-only files inside a Git worktree", async () => {
    apiMocks.localReviewStatus.mockResolvedValue({
      workspacePath: "F:/research",
      ledgerRoot: "F:/research/.somniq/changes",
      recordCount: 1,
      files: [{
        changeId: "chg-ignored-1",
        path: "ignored/output.txt",
        operation: "create",
        status: "applied",
        toolName: "write_file",
        timestamp: "2026-08-28T12:00:00Z",
        beforeExists: false,
        afterExists: true,
        additions: 1,
        deletions: 0,
        unifiedDiff: "--- /dev/null\n+++ ignored/output.txt\n@@ -0,0 +1 @@\n+local-output\n",
        truncated: false,
        reversible: true,
      }],
    });

    render(<GitWorkspace />);

    fireEvent.click(await screen.findByTitle("ignored"));
    fireEvent.click(await screen.findByText("output.txt"));
    expect(await screen.findByText("local-output")).toBeTruthy();
    expect(screen.getByText("Local record")).toBeTruthy();
  });

  it("presents untracked Git files as added files without Git index jargon", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      files: [{
        ...changedSnapshot().files[0],
        path: "notes/new-paper.md",
        worktreeStatus: "?",
        untracked: true,
      }],
    });

    render(<GitWorkspace embedded />);

    expect(await screen.findByText("new-paper.md")).toBeTruthy();
    expect(screen.getAllByText("Added").length).toBeGreaterThan(0);
    expect(screen.queryByText("Untracked")).toBeNull();
    expect(screen.queryByRole("button", { name: /Untracked/ })).toBeNull();
  });

  it("keeps large generated directories collapsed until the reviewer opens them", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      files: [
        changedSnapshot().files[0],
        ...Array.from({ length: 25 }, (_, index) => ({
          path: `generated/cache/artifact-${index}.tmp`,
          oldPath: null,
          indexStatus: null,
          worktreeStatus: "?",
          staged: false,
          unstaged: true,
          untracked: true,
          conflicted: false,
          additions: 0,
          deletions: 0,
        })),
      ],
    });

    render(<GitWorkspace embedded />);

    const generatedGroup = await screen.findByTitle("generated/cache");
    expect(generatedGroup.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("artifact-0.tmp")).toBeNull();

    fireEvent.click(generatedGroup);
    expect(await screen.findByText("artifact-0.tmp")).toBeTruthy();
    expect(generatedGroup.getAttribute("aria-expanded")).toBe("true");
  });

  it("builds nested folders instead of rendering full paths as peer groups", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      files: [
        {
          ...changedSnapshot().files[0],
          path: "Final/Ch3/ch3.tex",
          additions: 3,
          deletions: 0,
        },
        {
          ...changedSnapshot().files[0],
          path: "Final/Ch3/Mathmatic/equation.tex",
          additions: 7,
          deletions: 0,
        },
        {
          ...changedSnapshot().files[0],
          path: "Final/Ch4/SMC2026/paper.tex",
          additions: 11,
          deletions: 0,
        },
      ],
    });

    render(<GitWorkspace embedded />);

    const finalFolder = await screen.findByTitle("Final");
    const ch3Folder = await screen.findByTitle("Final/Ch3");
    const compactCh4Folder = await screen.findByTitle("Final/Ch4/SMC2026");

    expect(finalFolder.getAttribute("aria-expanded")).toBe("true");
    expect(ch3Folder.textContent).toContain("Ch3");
    expect(ch3Folder.textContent).not.toContain("Final/Ch3");
    expect(compactCh4Folder.textContent).toContain("Ch4/SMC2026");
    expect(finalFolder.closest("section")?.contains(ch3Folder)).toBe(true);
    expect(finalFolder.querySelector(".git-file-group-count")?.textContent).toBe("3");
  });

  it("steps between filtered files from the diff header", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      files: [
        changedSnapshot().files[0],
        {
          ...changedSnapshot().files[0],
          path: "notes/results.md",
        },
      ],
    });
    apiMocks.gitDiff.mockImplementation((path: string, staged: boolean) => Promise.resolve({
      path,
      staged,
      content: `@@ -1 +1 @@\n-old\n+${path}\n`,
      truncated: false,
    }));

    render(<GitWorkspace embedded />);

    await waitFor(() => expect(apiMocks.gitDiff).toHaveBeenCalledWith("notes/paper.md", false));
    expect(screen.getByRole("button", { name: "All 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next changed file" }));
    await waitFor(() => expect(apiMocks.gitDiff).toHaveBeenCalledWith("notes/results.md", false));
    expect(screen.getByRole("button", { name: "notes/results.md" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a syntax-highlighted code frame and collapses untouched lines", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      files: [{
        ...changedSnapshot().files[0],
        path: "crates/executor/src/lib.rs",
        additions: 3,
        deletions: 0,
      }],
    });
    apiMocks.gitDiff.mockResolvedValue({
      path: "crates/executor/src/lib.rs",
      staged: false,
      content: "@@ -74,2 +74,3 @@\n pub trait Executor {\n+    fn review(&self);\n }\n",
      truncated: false,
    });

    const { container } = render(<GitWorkspace embedded />);

    expect(await screen.findByText("73 unmodified lines")).toBeTruthy();
    expect(container.querySelector(".review-code-frame")).toBeTruthy();
    expect(container.querySelector(".review-code-frame .hljs-keyword")?.textContent).toBe("pub");
    expect(screen.queryByText("@@ -74,2 +74,3 @@")).toBeNull();
  });

  it("announces single-file navigation for a very large review", async () => {
    apiMocks.gitStatus.mockResolvedValue({
      ...changedSnapshot(),
      files: [{
        ...changedSnapshot().files[0],
        additions: 5_000,
        deletions: 1,
      }],
    });

    render(<GitWorkspace embedded />);

    expect(await screen.findByText("This diff is large. Reviewing one file at a time.")).toBeTruthy();
    expect(screen.getByRole("note")).toBeTruthy();
  });

  it("parses unified diff line numbers and change kinds", () => {
    const lines = parseReviewDiff("@@ -3,2 +3,2 @@\n-old\n+new\n keep");
    expect(lines[0].kind).toBe("metadata");
    expect(lines[1]).toMatchObject({ kind: "deletion", oldLine: 3, text: "old" });
    expect(lines[2]).toMatchObject({ kind: "addition", newLine: 3, text: "new" });
    expect(lines[3]).toMatchObject({ kind: "context", oldLine: 4, newLine: 4, text: "keep" });
  });

  it("derives collapsed ranges between unified diff hunks", () => {
    const rows = buildReviewDiffRows(
      "@@ -4,2 +4,2 @@\n-old\n+new\n keep\n@@ -12 +12 @@\n-before\n+after",
    );

    expect(rows[0]).toMatchObject({ kind: "collapsed", hiddenLines: 3 });
    expect(rows[4]).toMatchObject({ kind: "collapsed", hiddenLines: 6 });
  });
});
