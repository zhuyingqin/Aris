import { useCallback, useEffect, useMemo, useState } from "react";

import {
  gitBranchCreate,
  gitBranchSwitch,
  gitCommit,
  gitDiff,
  gitInitialize,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitDiffView,
  type GitFileChange,
  type GitWorkspaceSnapshot,
} from "../api/tauri";
import { useStore, type Language } from "../store";

type DiffMode = "working" | "staged";

type GitCopy = {
  title: string;
  subtitle: string;
  refresh: string;
  initialize: string;
  gitMissing: string;
  notRepository: string;
  changes: string;
  noChanges: string;
  stage: string;
  unstage: string;
  stageAll: string;
  unstageAll: string;
  workingTree: string;
  staged: string;
  diffEmpty: string;
  selectFile: string;
  truncated: string;
  commit: string;
  commitPlaceholder: string;
  createCommit: string;
  branches: string;
  switchBranch: string;
  newBranchPlaceholder: string;
  createBranch: string;
  detached: string;
  noUpstream: string;
  conflicted: string;
  untracked: string;
  modified: string;
  deleted: string;
  renamed: string;
  added: string;
  stagedBadge: string;
};

const COPY: Record<Language, GitCopy> = {
  cn: {
    title: "Git 管理",
    subtitle: "审查并提交当前项目的本地变更",
    refresh: "刷新",
    initialize: "初始化 Git 仓库",
    gitMissing: "未检测到 Git。请先安装 Git 并确保它在系统 PATH 中可用。",
    notRepository: "当前项目还不是 Git 仓库。初始化只会在项目中创建本地 .git 目录。",
    changes: "文件变更",
    noChanges: "工作区干净，没有待提交的变更。",
    stage: "暂存",
    unstage: "取消暂存",
    stageAll: "全部暂存",
    unstageAll: "全部取消",
    workingTree: "工作区",
    staged: "暂存区",
    diffEmpty: "此选择没有可显示的文本差异。",
    selectFile: "选择一个文件以查看差异。",
    truncated: "差异过大，当前视图已截断。",
    commit: "创建提交",
    commitPlaceholder: "描述这次变更…",
    createCommit: "提交已暂存变更",
    branches: "本地分支",
    switchBranch: "切换",
    newBranchPlaceholder: "新分支名称",
    createBranch: "创建并切换",
    detached: "游离 HEAD",
    noUpstream: "未设置上游",
    conflicted: "冲突",
    untracked: "未跟踪",
    modified: "已修改",
    deleted: "已删除",
    renamed: "已重命名",
    added: "新增",
    stagedBadge: "已暂存",
  },
  en: {
    title: "Git",
    subtitle: "Review and commit local changes in the current project",
    refresh: "Refresh",
    initialize: "Initialize Git repository",
    gitMissing: "Git was not detected. Install Git and make sure it is available on PATH.",
    notRepository: "This project is not a Git repository. Initialization only creates a local .git directory.",
    changes: "File changes",
    noChanges: "The working tree is clean. There are no changes to commit.",
    stage: "Stage",
    unstage: "Unstage",
    stageAll: "Stage all",
    unstageAll: "Unstage all",
    workingTree: "Working tree",
    staged: "Staged",
    diffEmpty: "No textual diff is available for this selection.",
    selectFile: "Select a file to inspect its diff.",
    truncated: "This diff is large and has been truncated in the current view.",
    commit: "Create commit",
    commitPlaceholder: "Describe this change…",
    createCommit: "Commit staged changes",
    branches: "Local branches",
    switchBranch: "Switch",
    newBranchPlaceholder: "New branch name",
    createBranch: "Create and switch",
    detached: "Detached HEAD",
    noUpstream: "No upstream",
    conflicted: "Conflict",
    untracked: "Untracked",
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    added: "Added",
    stagedBadge: "Staged",
  },
};

export function preferredDiffMode(change: GitFileChange): DiffMode {
  return change.unstaged || change.untracked ? "working" : "staged";
}

function changeKind(change: GitFileChange, copy: GitCopy): string {
  if (change.conflicted) return copy.conflicted;
  if (change.untracked) return copy.untracked;
  const codes = `${change.indexStatus ?? ""}${change.worktreeStatus ?? ""}`;
  if (codes.includes("R")) return copy.renamed;
  if (codes.includes("D")) return copy.deleted;
  if (codes.includes("A")) return copy.added;
  return copy.modified;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function uniquePaths(files: GitFileChange[], predicate: (file: GitFileChange) => boolean): string[] {
  return Array.from(new Set(files.filter(predicate).flatMap(changePaths)));
}

function changePaths(change: GitFileChange): string[] {
  return change.oldPath ? [change.path, change.oldPath] : [change.path];
}

export default function GitWorkspace() {
  const language = useStore((state) => state.language);
  const currentProject = useStore((state) => state.currentProject);
  const copy = COPY[language];
  const [snapshot, setSnapshot] = useState<GitWorkspaceSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("working");
  const [diff, setDiff] = useState<GitDiffView | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [branchSelection, setBranchSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const acceptSnapshot = useCallback((next: GitWorkspaceSnapshot) => {
    setSnapshot(next);
    setBranchSelection(next.branch ?? "");
    setSelectedPath((current) => {
      if (current && next.files.some((file) => file.path === current)) return current;
      const first = next.files[0] ?? null;
      if (first) setDiffMode(preferredDiffMode(first));
      return first?.path ?? null;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      acceptSnapshot(await gitStatus());
    } catch (reason) {
      setError(String(reason));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    setSnapshot(null);
    setSelectedPath(null);
    setDiff(null);
    void refresh();
  }, [currentProject?.id, refresh]);

  const selectedChange = useMemo(
    () => snapshot?.files.find((file) => file.path === selectedPath) ?? null,
    [selectedPath, snapshot],
  );

  useEffect(() => {
    if (!selectedChange) return;
    if (diffMode === "working" && !selectedChange.unstaged && !selectedChange.untracked) {
      setDiffMode("staged");
    } else if (diffMode === "staged" && !selectedChange.staged) {
      setDiffMode("working");
    }
  }, [diffMode, selectedChange]);

  useEffect(() => {
    if (!selectedPath || !selectedChange) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    void gitDiff(selectedPath, diffMode === "staged")
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [diffMode, selectedChange, selectedPath]);

  const mutate = useCallback(async (
    action: () => Promise<GitWorkspaceSnapshot>,
    after?: () => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      acceptSnapshot(await action());
      after?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot]);

  const unstagedPaths = snapshot
    ? uniquePaths(snapshot.files, (file) => file.unstaged || file.untracked)
    : [];
  const stagedPaths = snapshot
    ? uniquePaths(snapshot.files, (file) => file.staged)
    : [];

  const selectChange = (change: GitFileChange) => {
    setSelectedPath(change.path);
    setDiffMode(preferredDiffMode(change));
    setError(null);
  };

  return (
    <section className="git-workspace" aria-label={copy.title}>
      <header className="git-header">
        <div className="git-title-group">
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        {snapshot?.isRepository && (
          <div className="git-repository-summary">
            <span className="git-branch-pill">
              {snapshot.detached ? copy.detached : snapshot.branch ?? "HEAD"}
            </span>
            <span className="git-upstream" title={snapshot.upstream ?? copy.noUpstream}>
              {snapshot.upstream ?? copy.noUpstream}
              {(snapshot.ahead > 0 || snapshot.behind > 0) && ` · ↑${snapshot.ahead} ↓${snapshot.behind}`}
            </span>
          </div>
        )}
        <button className="git-button ghost" type="button" disabled={loading || busy} onClick={() => void refresh()}>
          {copy.refresh}
        </button>
      </header>

      {error && <div className="git-error" role="alert">{error}</div>}

      {loading && !snapshot ? (
        <div className="git-empty" role="status"><span className="app-loading-spinner" />{copy.refresh}…</div>
      ) : snapshot && !snapshot.gitAvailable ? (
        <div className="git-empty">
          <strong>Git</strong>
          <p>{copy.gitMissing}</p>
        </div>
      ) : snapshot && !snapshot.isRepository ? (
        <div className="git-empty">
          <strong>{currentProject?.name ?? copy.title}</strong>
          <p>{copy.notRepository}</p>
          <button className="git-button primary" type="button" disabled={busy} onClick={() => void mutate(gitInitialize)}>
            {copy.initialize}
          </button>
        </div>
      ) : snapshot ? (
        <div className="git-layout">
          <aside className="git-sidebar">
            <section className="git-section git-branches">
              <div className="git-section-heading"><strong>{copy.branches}</strong></div>
              <div className="git-inline-form">
                <select
                  aria-label={copy.branches}
                  value={branchSelection}
                  disabled={busy || snapshot.branches.length === 0}
                  onChange={(event) => setBranchSelection(event.target.value)}
                >
                  {snapshot.branches.map((branch) => <option value={branch.name} key={branch.name}>{branch.name}</option>)}
                </select>
                <button
                  className="git-button"
                  type="button"
                  disabled={busy || !branchSelection || branchSelection === snapshot.branch}
                  onClick={() => void mutate(() => gitBranchSwitch(branchSelection))}
                >
                  {copy.switchBranch}
                </button>
              </div>
              <div className="git-inline-form">
                <input
                  value={newBranch}
                  placeholder={copy.newBranchPlaceholder}
                  aria-label={copy.newBranchPlaceholder}
                  disabled={busy}
                  onChange={(event) => setNewBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && newBranch.trim()) {
                      void mutate(() => gitBranchCreate(newBranch), () => setNewBranch(""));
                    }
                  }}
                />
                <button
                  className="git-button"
                  type="button"
                  disabled={busy || !newBranch.trim()}
                  onClick={() => void mutate(() => gitBranchCreate(newBranch), () => setNewBranch(""))}
                >
                  {copy.createBranch}
                </button>
              </div>
            </section>

            <section className="git-section git-changes-section">
              <div className="git-section-heading">
                <strong>{copy.changes}</strong>
                <span>{snapshot.files.length}</span>
              </div>
              <div className="git-bulk-actions">
                <button className="git-text-button" type="button" disabled={busy || unstagedPaths.length === 0} onClick={() => void mutate(() => gitStage(unstagedPaths))}>
                  {copy.stageAll}
                </button>
                <button className="git-text-button" type="button" disabled={busy || stagedPaths.length === 0} onClick={() => void mutate(() => gitUnstage(stagedPaths))}>
                  {copy.unstageAll}
                </button>
              </div>
              <div className="git-file-list">
                {snapshot.files.length === 0 && <p className="git-clean">{copy.noChanges}</p>}
                {snapshot.files.map((change) => (
                  <div
                    className={`git-file-row${selectedPath === change.path ? " selected" : ""}`}
                    key={change.path}
                  >
                    <button className="git-file-select" type="button" onClick={() => selectChange(change)}>
                      <span className="git-file-copy">
                        <span className="git-file-name">{basename(change.path)}</span>
                        <span className="git-file-dir">{dirname(change.path)}</span>
                      </span>
                      <span className="git-file-badges">
                        <span className={`git-status-badge${change.conflicted ? " danger" : ""}`}>{changeKind(change, copy)}</span>
                        {change.staged && <span className="git-status-badge staged">{copy.stagedBadge}</span>}
                      </span>
                    </button>
                    <span className="git-row-actions">
                      {(change.unstaged || change.untracked) && (
                        <button
                          className="git-row-action"
                          type="button"
                          onClick={() => {
                            void mutate(() => gitStage(changePaths(change)));
                          }}
                        >{copy.stage}</button>
                      )}
                      {change.staged && (
                        <button
                          className="git-row-action"
                          type="button"
                          onClick={() => {
                            void mutate(() => gitUnstage(changePaths(change)));
                          }}
                        >{copy.unstage}</button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="git-section git-commit-section">
              <div className="git-section-heading"><strong>{copy.commit}</strong></div>
              <textarea
                value={commitMessage}
                placeholder={copy.commitPlaceholder}
                aria-label={copy.commitPlaceholder}
                disabled={busy}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <button
                className="git-button primary wide"
                type="button"
                disabled={busy || stagedPaths.length === 0 || !commitMessage.trim() || snapshot.hasConflicts}
                onClick={() => void mutate(() => gitCommit(commitMessage), () => setCommitMessage(""))}
              >
                {copy.createCommit}
              </button>
            </section>
          </aside>

          <main className="git-diff-pane">
            {selectedChange ? (
              <>
                <div className="git-diff-header">
                  <div className="git-diff-title" title={selectedChange.path}>{selectedChange.path}</div>
                  <div className="git-diff-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={diffMode === "working"}
                      className={diffMode === "working" ? "active" : ""}
                      disabled={!selectedChange.unstaged && !selectedChange.untracked}
                      onClick={() => setDiffMode("working")}
                    >{copy.workingTree}</button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={diffMode === "staged"}
                      className={diffMode === "staged" ? "active" : ""}
                      disabled={!selectedChange.staged}
                      onClick={() => setDiffMode("staged")}
                    >{copy.staged}</button>
                  </div>
                </div>
                {diff ? (
                  <div className="git-diff-scroll">
                    {diff.truncated && <div className="git-diff-warning">{copy.truncated}</div>}
                    <pre>{diff.content || copy.diffEmpty}</pre>
                  </div>
                ) : (
                  <div className="git-diff-loading" role="status"><span className="app-loading-spinner" /></div>
                )}
              </>
            ) : (
              <div className="git-diff-placeholder">{copy.selectFile}</div>
            )}
          </main>
        </div>
      ) : null}
    </section>
  );
}
