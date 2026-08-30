import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  gitBranchCreate,
  gitBranchSwitch,
  gitCommit,
  gitDiff,
  gitInitialize,
  gitStage,
  gitStatus,
  gitUnstage,
  localReviewStatus,
  type GitDiffView,
  type GitFileChange,
  type GitWorkspaceSnapshot,
  type LocalReviewFileChange,
  type LocalReviewSnapshot,
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
  noLedgerChanges: string;
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
  providerGit: string;
  providerLedger: string;
  providerUnavailable: string;
  filterAll: string;
  filterStaged: string;
  filterUnstaged: string;
  filterUntracked: string;
  filterConflicted: string;
  searchFiles: string;
  openInCode: string;
  nativeDiffHint: string;
  ledgerTitle: string;
  ledgerBody: string;
  aiChange: string;
};

const COPY: Record<Language, GitCopy> = {
  cn: {
    title: "Review",
    subtitle: "查看并确认当前项目的所有变更",
    refresh: "刷新",
    initialize: "初始化 Git 仓库",
    gitMissing: "未检测到 Git。应用仍可使用本地变更记录；需要分支、暂存和提交时，可以稍后安装 Git。",
    notRepository: "当前项目还不是 Git 仓库。初始化只会在项目中创建本地 .git 目录。",
    noLedgerChanges: "当前项目没有可用的本地变更记录。",
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
    providerGit: "Git 工作区",
    providerLedger: "本地变更记录",
    providerUnavailable: "未建立变更来源",
    filterAll: "全部",
    filterStaged: "已暂存",
    filterUnstaged: "未暂存",
    filterUntracked: "未跟踪",
    filterConflicted: "冲突",
    searchFiles: "搜索变更文件",
    openInCode: "在 Code 中打开 Diff",
    nativeDiffHint: "使用内置 VSCodium 的原生 Diff 查看器",
    ledgerTitle: "SomniQ 本地变更记录",
    ledgerBody: "没有 Git，或 Git 忽略了某个文件时，AI 和编辑器的已记录修改仍会显示在这里。",
    aiChange: "本地记录",
  },
  en: {
    title: "Review",
    subtitle: "Inspect and confirm all changes in the current project",
    refresh: "Refresh",
    initialize: "Initialize Git repository",
    gitMissing: "Git was not detected. The app still works with local change records; install Git later when you need branches, staging, or commits.",
    notRepository: "This project is not a Git repository. Initialization only creates a local .git directory.",
    noLedgerChanges: "There are no local change records for this project.",
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
    providerGit: "Git worktree",
    providerLedger: "Local change ledger",
    providerUnavailable: "No change source",
    filterAll: "All",
    filterStaged: "Staged",
    filterUnstaged: "Unstaged",
    filterUntracked: "Untracked",
    filterConflicted: "Conflicts",
    searchFiles: "Search changed files",
    openInCode: "Open Diff in Code",
    nativeDiffHint: "Use the embedded VSCodium native Diff viewer",
    ledgerTitle: "SomniQ local change ledger",
    ledgerBody: "Recorded AI and editor changes remain visible here when Git is unavailable or ignores a file.",
    aiChange: "Local record",
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

function localChangeKind(change: LocalReviewFileChange, copy: GitCopy): string {
  if (change.status === "conflict") return copy.conflicted;
  if (change.operation === "create") return copy.added;
  if (change.operation === "delete") return copy.deleted;
  if (change.operation === "rename") return copy.renamed;
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

function absoluteProjectPath(workspace: string, path: string): string {
  return workspace.replace(/[\\/]+$/, "") + "/" + path.replace(/^[/\\]+/, "").replace(/\\/g, "/");
}

type DiffLineKind = "addition" | "deletion" | "context" | "metadata";

type ParsedDiffLine = {
  oldLine: number | null;
  newLine: number | null;
  marker: string;
  text: string;
  kind: DiffLineKind;
};

export function parseReviewDiff(content: string): ParsedDiffLine[] {
  if (!content) return [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return content.split(/\r?\n/).map((line) => {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
        inHunk = true;
      }
      return { oldLine: null, newLine: null, marker: "", text: line, kind: "metadata" };
    }
    if (!inHunk || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      return { oldLine: null, newLine: null, marker: "", text: line, kind: "metadata" };
    }
    if (line.startsWith("+")) {
      const result = { oldLine: null, newLine, marker: "+", text: line.slice(1), kind: "addition" as const };
      newLine += 1;
      return result;
    }
    if (line.startsWith("-")) {
      const result = { oldLine, newLine: null, marker: "-", text: line.slice(1), kind: "deletion" as const };
      oldLine += 1;
      return result;
    }
    if (line.startsWith(" ")) {
      const result = { oldLine, newLine, marker: " ", text: line.slice(1), kind: "context" as const };
      oldLine += 1;
      newLine += 1;
      return result;
    }
    return { oldLine: null, newLine: null, marker: "", text: line, kind: "metadata" };
  });
}

function DiffViewer({ diff, copy }: { diff: GitDiffView; copy: GitCopy }) {
  const lines = useMemo(() => parseReviewDiff(diff.content), [diff.content]);
  if (!diff.content) {
    return <div className="git-diff-placeholder">{copy.diffEmpty}</div>;
  }
  return (
    <div className="git-diff-scroll">
      {diff.truncated && <div className="git-diff-warning">{copy.truncated}</div>}
      <div className="review-diff-lines" role="table" aria-label="File diff">
        {lines.map((line, index) => (
          <div className={"review-diff-line review-diff-line-" + line.kind} role="row" key={index}>
            <span className="review-diff-number" aria-hidden="true">{line.oldLine ?? ""}</span>
            <span className="review-diff-number" aria-hidden="true">{line.newLine ?? ""}</span>
            <span className="review-diff-marker" aria-hidden="true">{line.marker}</span>
            <code>{line.text || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

type ReviewFile = {
  path: string;
  oldPath?: string | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  additions: number;
  deletions: number;
  kind: string;
  local?: LocalReviewFileChange;
};

function localReviewFile(change: LocalReviewFileChange, copy: GitCopy): ReviewFile {
  return {
    path: change.path,
    staged: false,
    unstaged: true,
    untracked: change.operation === "create",
    conflicted: change.status === "conflict",
    additions: change.additions,
    deletions: change.deletions,
    kind: localChangeKind(change, copy),
    local: change,
  };
}

function reviewPathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

type ReviewFilter = "all" | "staged" | "unstaged" | "untracked" | "conflicted";
type ReviewProvider = "git" | "local-ledger" | "unavailable";

function filterMatches(file: ReviewFile, filter: ReviewFilter): boolean {
  if (filter === "staged") return file.staged;
  if (filter === "unstaged") return file.unstaged;
  if (filter === "untracked") return file.untracked;
  if (filter === "conflicted") return file.conflicted;
  return true;
}

function providerLabel(provider: ReviewProvider, copy: GitCopy): string {
  if (provider === "git") return copy.providerGit;
  if (provider === "local-ledger") return copy.providerLedger;
  return copy.providerUnavailable;
}

function sameReviewSnapshot(
  current: GitWorkspaceSnapshot | LocalReviewSnapshot | null,
  next: GitWorkspaceSnapshot | LocalReviewSnapshot,
): boolean {
  return current !== null && JSON.stringify(current) === JSON.stringify(next);
}

export default function GitWorkspace({ embedded = false }: { embedded?: boolean } = {}) {
  const language = useStore((state) => state.language);
  const currentProject = useStore((state) => state.currentProject);
  const setPendingCodeDiff = useStore((state) => state.setPendingCodeDiff);
  const setTab = useStore((state) => state.setTab);
  const copy = COPY[language];
  const [snapshot, setSnapshot] = useState<GitWorkspaceSnapshot | null>(null);
  const [localSnapshot, setLocalSnapshot] = useState<LocalReviewSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("working");
  const [diff, setDiff] = useState<GitDiffView | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [branchSelection, setBranchSelection] = useState("");
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
  const mutationInFlight = useRef(false);

  const acceptSnapshot = useCallback((next: GitWorkspaceSnapshot) => {
    setSnapshot((current) => sameReviewSnapshot(current, next) ? current : next);
    setBranchSelection(next.branch ?? "");
    setSelectedPath((current) => {
      // Keep the current selection across refreshes. The merged local ledger
      // can contain a file that is invisible to Git (for example, ignored
      // output), so checking only `next.files` would jump the user away from
      // it every time the status poll runs. The filtered-file effect below
      // still repairs a selection that genuinely disappeared.
      if (current) return current;
      const first = next.files[0] ?? null;
      if (first) setDiffMode(preferredDiffMode(first));
      return first?.path ?? null;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current || mutationInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const [gitResult, localResult] = await Promise.allSettled([gitStatus(), localReviewStatus()]);
      let failed = true;
      if (gitResult.status === "fulfilled") {
        acceptSnapshot(gitResult.value);
        failed = false;
      }
      if (localResult.status === "fulfilled") {
        setLocalSnapshot((current) => (
          sameReviewSnapshot(current, localResult.value) ? current : localResult.value
        ));
        failed = false;
      }
      if (failed) {
        const reason = gitResult.status === "rejected"
          ? gitResult.reason
          : localResult.status === "rejected"
            ? localResult.reason
            : "Review data is unavailable";
        setError(String(reason));
      }
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    setSnapshot(null);
    setLocalSnapshot(null);
    setSelectedPath(null);
    setDiff(null);
    setFilter("all");
    setSearch("");
    void refresh();
  }, [currentProject?.id, refresh]);

  const gitReady = Boolean(snapshot?.gitAvailable && snapshot.isRepository);
  const ledgerFiles = localSnapshot?.files ?? [];
  const provider: ReviewProvider = gitReady
    ? "git"
    : ledgerFiles.length > 0
      ? "local-ledger"
      : "unavailable";

  const files = useMemo<ReviewFile[]>(() => {
    if (provider === "git") {
      const gitFiles = (snapshot?.files ?? []).map((change) => ({
        path: change.path,
        oldPath: change.oldPath,
        staged: change.staged,
        unstaged: change.unstaged,
        untracked: change.untracked,
        conflicted: change.conflicted,
        additions: change.additions ?? 0,
        deletions: change.deletions ?? 0,
        kind: changeKind(change, copy),
      }));
      const gitPaths = new Set(gitFiles.map((file) => reviewPathKey(file.path)));
      const ledgerOnlyFiles = ledgerFiles
        .filter((change) => !gitPaths.has(reviewPathKey(change.path)))
        .map((change) => localReviewFile(change, copy));
      return [...gitFiles, ...ledgerOnlyFiles];
    }
    if (provider === "local-ledger") {
      return ledgerFiles.map((change) => localReviewFile(change, copy));
    }
    return [];
  }, [copy, ledgerFiles, provider, snapshot?.files]);

  const filteredFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return files.filter((file) => {
      if (!filterMatches(file, filter)) return false;
      if (!query) return true;
      return (file.path + " " + (file.oldPath ?? "")).toLowerCase().includes(query);
    });
  }, [files, filter, search]);

  const groupedFiles = useMemo(() => {
    const groups = new Map<string, ReviewFile[]>();
    for (const file of filteredFiles) {
      const group = dirname(file.path) || ".";
      const entries = groups.get(group) ?? [];
      entries.push(file);
      groups.set(group, entries);
    }
    return Array.from(groups.entries());
  }, [filteredFiles]);

  useEffect(() => {
    if (selectedPath && filteredFiles.some((file) => file.path === selectedPath)) return;
    setSelectedPath(filteredFiles[0]?.path ?? null);
  }, [filteredFiles, selectedPath]);

  const selectedChange = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  useEffect(() => {
    if (!selectedChange || provider !== "git") return;
    if (diffMode === "working" && !selectedChange.unstaged && !selectedChange.untracked) {
      setDiffMode("staged");
    } else if (diffMode === "staged" && !selectedChange.staged) {
      setDiffMode("working");
    }
  }, [diffMode, provider, selectedChange]);

  useEffect(() => {
    if (!selectedChange) {
      setDiff(null);
      return;
    }
    if (selectedChange.local) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    const staged = diffMode === "staged";
    setDiff((current) => (
      current?.path === selectedChange.path && current.staged === staged ? current : null
    ));
    void gitDiff(selectedChange.path, staged)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [diffMode, selectedChange]);

  // Local ledger records already carry their immutable diff, so they should
  // never spend a render in a loading state. Git diffs still come from the
  // backend and use the asynchronous `diff` state above.
  const renderedDiff = selectedChange?.local
    ? {
        path: selectedChange.path,
        staged: false,
        content: selectedChange.local.unifiedDiff,
        truncated: selectedChange.local.truncated,
      }
    : diff;

  const mutate = useCallback(async (
    action: () => Promise<GitWorkspaceSnapshot>,
    after?: () => void,
  ) => {
    mutationInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      acceptSnapshot(await action());
      after?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  }, [acceptSnapshot]);

  const unstagedPaths = snapshot
    ? uniquePaths(snapshot.files, (file) => file.unstaged || file.untracked)
    : [];
  const stagedPaths = snapshot
    ? uniquePaths(snapshot.files, (file) => file.staged)
    : [];
  const totals = files.reduce(
    (result, file) => ({
      additions: result.additions + file.additions,
      deletions: result.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  const selectChange = (change: ReviewFile) => {
    setSelectedPath(change.path);
    if (!change.local) {
      const gitChange = snapshot?.files.find((file) => file.path === change.path);
      if (gitChange) setDiffMode(preferredDiffMode(gitChange));
    } else {
      setDiffMode("working");
    }
    setError(null);
  };

  const openNativeDiff = () => {
    if (!currentProject || !selectedChange || selectedChange.local || provider !== "git") return;
    setPendingCodeDiff({
      path: absoluteProjectPath(currentProject.path, selectedChange.path),
      staged: diffMode === "staged",
    });
    setTab("lab");
  };

  const showEmpty = provider === "unavailable" || (provider === "git" && files.length === 0);
  const noGit = snapshot != null && !snapshot.gitAvailable;
  const noRepository = snapshot != null && snapshot.gitAvailable && !snapshot.isRepository;

  return (
    <section className={`git-workspace${embedded ? " embedded" : ""}`} aria-label={copy.title}>
      <header className="git-header">
        <div className="git-title-group">
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <div className="git-review-summary">
          <span className="git-provider-pill">{providerLabel(provider, copy)}</span>
          <span className="git-review-stat"><strong>{files.length}</strong> {copy.changes}</span>
          <span className="git-review-stat git-review-additions">+{totals.additions}</span>
          <span className="git-review-stat git-review-deletions">-{totals.deletions}</span>
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

      {loading && !snapshot && !localSnapshot ? (
        <div className="git-empty" role="status"><span className="app-loading-spinner" />{copy.refresh}…</div>
      ) : showEmpty && noGit ? (
        <div className="git-empty">
          <strong>Git</strong>
          <p>{copy.gitMissing}</p>
        </div>
      ) : showEmpty && noRepository ? (
        <div className="git-empty">
          <strong>{currentProject?.name ?? copy.title}</strong>
          <p>{copy.notRepository}</p>
          <button className="git-button primary" type="button" disabled={busy} onClick={() => void mutate(gitInitialize)}>
            {copy.initialize}
          </button>
        </div>
      ) : showEmpty ? (
        <div className="git-empty">
          <strong>{currentProject?.name ?? copy.title}</strong>
          <p>{provider === "git" ? copy.noChanges : copy.noLedgerChanges}</p>
        </div>
      ) : snapshot || localSnapshot ? (
        <div className="git-layout">
          <aside className="git-sidebar">
            {!embedded && provider === "git" && snapshot?.isRepository && (
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
            )}

            {provider === "local-ledger" && localSnapshot && (
              <section className="git-section git-ledger-info">
                <div className="git-section-heading"><strong>{copy.ledgerTitle}</strong></div>
                <p title={localSnapshot.ledgerRoot}>{copy.ledgerBody}</p>
                {noRepository && (
                  <>
                    <p>{copy.notRepository}</p>
                    <button className="git-button primary wide" type="button" disabled={busy} onClick={() => void mutate(gitInitialize)}>
                      {copy.initialize}
                    </button>
                  </>
                )}
              </section>
            )}

            <section className="git-section git-changes-section">
              <div className="git-section-heading">
                <strong>{copy.changes}</strong>
                <span>{filteredFiles.length}/{files.length}</span>
              </div>
              <input
                className="git-file-search"
                type="search"
                value={search}
                placeholder={copy.searchFiles}
                aria-label={copy.searchFiles}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="git-filter-list" role="group" aria-label={copy.changes}>
                {([
                  ["all", copy.filterAll],
                  ["staged", copy.filterStaged],
                  ["unstaged", copy.filterUnstaged],
                  ["untracked", copy.filterUntracked],
                  ["conflicted", copy.filterConflicted],
                ] as const).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={filter === value ? "active" : ""}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >{label}</button>
                ))}
              </div>
              {provider === "git" && (
              <div className="git-bulk-actions">
                <button className="git-text-button" type="button" disabled={busy || unstagedPaths.length === 0} onClick={() => void mutate(() => gitStage(unstagedPaths))}>
                  {copy.stageAll}
                </button>
                <button className="git-text-button" type="button" disabled={busy || stagedPaths.length === 0} onClick={() => void mutate(() => gitUnstage(stagedPaths))}>
                  {copy.unstageAll}
                </button>
              </div>
              )}
              <div className="git-file-list review-file-list">
                {filteredFiles.length === 0 && <p className="git-clean">{files.length === 0 ? copy.noChanges : copy.noLedgerChanges}</p>}
                {groupedFiles.map(([group, groupFiles]) => (
                  <section className="git-file-group" key={group}>
                    {group !== "." && <div className="git-file-group-heading">{group}</div>}
                    {groupFiles.map((change) => (
                      <div
                        className={"git-file-row" + (selectedPath === change.path ? " selected" : "")}
                        key={change.path}
                      >
                        <button
                          className="git-file-select"
                          type="button"
                          aria-pressed={selectedPath === change.path}
                          onClick={() => selectChange(change)}
                        >
                          <span className="git-file-copy">
                            <span className="git-file-name">{basename(change.path)}</span>
                            {dirname(change.path) && <span className="git-file-dir">{dirname(change.path)}</span>}
                          </span>
                          <span className="git-file-badges">
                            <span className="git-file-stats">
                              <span className="git-file-additions">+{change.additions}</span>
                              <span className="git-file-deletions">-{change.deletions}</span>
                            </span>
                            <span className={"git-status-badge" + (change.conflicted ? " danger" : "")}>{change.kind}</span>
                            {change.staged && <span className="git-status-badge staged">{copy.stagedBadge}</span>}
                          </span>
                        </button>
                        {provider === "git" && !change.local && (
                          <span className="git-row-actions">
                            {(change.unstaged || change.untracked) && (
                              <button
                                className="git-row-action"
                                type="button"
                                onClick={() => {
                                  const gitChange = snapshot?.files.find((file) => file.path === change.path);
                                  if (gitChange) void mutate(() => gitStage(changePaths(gitChange)));
                                }}
                              >{copy.stage}</button>
                            )}
                            {change.staged && (
                              <button
                                className="git-row-action"
                                type="button"
                                onClick={() => {
                                  const gitChange = snapshot?.files.find((file) => file.path === change.path);
                                  if (gitChange) void mutate(() => gitUnstage(changePaths(gitChange)));
                                }}
                              >{copy.unstage}</button>
                            )}
                          </span>
                        )}
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </section>

            {!embedded && provider === "git" && snapshot && (
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
                disabled={busy || stagedPaths.length === 0 || !commitMessage.trim() || Boolean(snapshot?.hasConflicts)}
                onClick={() => void mutate(() => gitCommit(commitMessage), () => setCommitMessage(""))}
              >
                {copy.createCommit}
              </button>
            </section>
            )}
          </aside>

          <main className="git-diff-pane">
            {selectedChange ? (
              <>
                <div className="git-diff-header">
                  <div className="git-diff-title-wrap">
                    <div className="git-diff-title" title={selectedChange.path}>{selectedChange.path}</div>
                    <span className="git-status-badge">{selectedChange.kind}</span>
                    {selectedChange.local && <span className="git-status-badge staged">{copy.aiChange}</span>}
                  </div>
                  <div className="git-diff-actions">
                    {provider === "git" && (
                      <button
                        className="git-button ghost"
                        type="button"
                        title={copy.nativeDiffHint}
                        disabled={!currentProject || busy}
                        onClick={openNativeDiff}
                      >{copy.openInCode}</button>
                    )}
                    {provider === "git" && (
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
                    )}
                  </div>
                </div>
                {renderedDiff ? <DiffViewer diff={renderedDiff} copy={copy} /> : (
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
