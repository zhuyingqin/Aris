// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitWorkspaceSnapshot } from "../api/tauri";
import { useStore } from "../store";
import GitWorkspace from "./GitWorkspace";

const apiMocks = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitInitialize: vi.fn(),
  gitStage: vi.fn(),
  gitUnstage: vi.fn(),
  gitCommit: vi.fn(),
  gitBranchCreate: vi.fn(),
  gitBranchSwitch: vi.fn(),
  gitDiff: vi.fn(),
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
});

afterEach(cleanup);

describe("GitWorkspace", () => {
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
});
