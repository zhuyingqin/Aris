// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitWorkspaceSnapshot } from "../api/tauri";
import { useStore } from "../store";
import GitWorkspace, { parseReviewDiff } from "./GitWorkspace";

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

  it("loads changes, stages a file, and commits the staged snapshot", async () => {
    render(<GitWorkspace />);

    expect(await screen.findByText("paper.md")).toBeTruthy();
    expect(screen.getByText("origin/main · ↑1 ↓0")).toBeTruthy();
    await waitFor(() => expect(apiMocks.gitDiff).toHaveBeenCalledWith("notes/paper.md", false));

    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(apiMocks.gitStage).toHaveBeenCalledWith(["notes/paper.md"]));

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

    fireEvent.click(await screen.findByText("output.txt"));
    expect(await screen.findByText("local-output")).toBeTruthy();
    expect(screen.getByText("Local record")).toBeTruthy();
  });

  it("parses unified diff line numbers and change kinds", () => {
    const lines = parseReviewDiff("@@ -3,2 +3,2 @@\n-old\n+new\n keep");
    expect(lines[0].kind).toBe("metadata");
    expect(lines[1]).toMatchObject({ kind: "deletion", oldLine: 3, text: "old" });
    expect(lines[2]).toMatchObject({ kind: "addition", newLine: 3, text: "new" });
    expect(lines[3]).toMatchObject({ kind: "context", oldLine: 4, newLine: 4, text: "keep" });
  });
});
