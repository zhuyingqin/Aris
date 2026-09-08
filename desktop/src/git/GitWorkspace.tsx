import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  gitBranchCreate,
  gitBranchSwitch,
  gitCommit,
  gitDiff,
  gitInitialize,
  gitStatus,
  localReviewStatus,
  type GitDiffView,
  type GitFileChange,
  type GitWorkspaceSnapshot,
  type LocalReviewFileChange,
  type LocalReviewSnapshot,
} from "../api/tauri";
import { SvgIcon } from "../SvgIcon";
import { useStore, type Language } from "../store";
import { highlightReviewLine } from "./reviewSyntax";
import "./GitWorkspace.css";

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
  modified: string;
  deleted: string;
  renamed: string;
  added: string;
  stagedBadge: string;
  providerGit: string;
  providerLedger: string;
  providerUnavailable: string;
  filterAll: string;
  filterConflicted: string;
  searchFiles: string;
  clearSearch: string;
  noMatches: string;
  expandAll: string;
  collapseAll: string;
  previousFile: string;
  nextFile: string;
  rootFiles: string;
  resizeFiles: string;
  resetFilesWidth: string;
  collapseFiles: string;
  expandFiles: string;
  openInCode: string;
  nativeDiffHint: string;
  largeReview: string;
  unchangedLines: (count: string) => string;
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
    modified: "已修改",
    deleted: "已删除",
    renamed: "已重命名",
    added: "新增",
    stagedBadge: "已暂存",
    providerGit: "Git 工作区",
    providerLedger: "本地变更记录",
    providerUnavailable: "未建立变更来源",
    filterAll: "全部",
    filterConflicted: "冲突",
    searchFiles: "搜索变更文件",
    clearSearch: "清除搜索",
    noMatches: "没有符合当前搜索或筛选条件的文件。",
    expandAll: "展开所有目录",
    collapseAll: "折叠所有目录",
    previousFile: "上一个变更文件",
    nextFile: "下一个变更文件",
    rootFiles: "项目根目录",
    resizeFiles: "调整变更文件面板宽度",
    resetFilesWidth: "双击恢复默认宽度",
    collapseFiles: "收起文件变更",
    expandFiles: "展开文件变更",
    openInCode: "在 Code 中打开 Diff",
    nativeDiffHint: "使用内置 VSCodium 的原生 Diff 查看器",
    largeReview: "此差异较大，每次仅显示一个文件",
    unchangedLines: (count) => `${count} 行未修改`,
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
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    added: "Added",
    stagedBadge: "Staged",
    providerGit: "Git worktree",
    providerLedger: "Local change ledger",
    providerUnavailable: "No change source",
    filterAll: "All",
    filterConflicted: "Conflicts",
    searchFiles: "Search changed files",
    clearSearch: "Clear search",
    noMatches: "No files match the current search and filters.",
    expandAll: "Expand all folders",
    collapseAll: "Collapse all folders",
    previousFile: "Previous changed file",
    nextFile: "Next changed file",
    rootFiles: "Project root",
    resizeFiles: "Resize changed files pane",
    resetFilesWidth: "Double-click to reset width",
    collapseFiles: "Collapse file changes",
    expandFiles: "Expand file changes",
    openInCode: "Open Diff in Code",
    nativeDiffHint: "Use the embedded VSCodium native Diff viewer",
    largeReview: "This diff is large. Reviewing one file at a time.",
    unchangedLines: (count) => `${count} unmodified lines`,
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
  if (change.untracked) return copy.added;
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

type CollapsedDiffRow = {
  oldLine: null;
  newLine: null;
  marker: "";
  text: "";
  kind: "collapsed";
  hiddenLines: number;
};

type ReviewDiffRow = ParsedDiffLine | CollapsedDiffRow;

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

export function buildReviewDiffRows(content: string): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = [];
  let nextOldLine: number | null = null;
  let nextNewLine: number | null = null;

  for (const line of parseReviewDiff(content)) {
    if (line.kind === "metadata") {
      const hunk = line.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        const oldStart = Number(hunk[1]);
        const newStart = Number(hunk[2]);
        const hiddenLines = nextOldLine == null || nextNewLine == null
          ? Math.max(0, Math.min(oldStart - 1, newStart - 1))
          : Math.max(0, Math.min(oldStart - nextOldLine, newStart - nextNewLine));
        if (hiddenLines > 0) {
          rows.push({
            oldLine: null,
            newLine: null,
            marker: "",
            text: "",
            kind: "collapsed",
            hiddenLines,
          });
        }
        nextOldLine = oldStart;
        nextNewLine = newStart;
      } else if (line.text.startsWith("\\")) {
        rows.push(line);
      }
      continue;
    }

    rows.push(line);
    if (line.oldLine != null) nextOldLine = line.oldLine + 1;
    if (line.newLine != null) nextNewLine = line.newLine + 1;
  }

  return rows;
}

const MAX_HIGHLIGHTED_DIFF_ROWS = 2_500;

function DiffViewer({ diff, copy, language }: { diff: GitDiffView; copy: GitCopy; language: Language }) {
  const rows = useMemo(() => buildReviewDiffRows(diff.content), [diff.content]);
  const highlightedRows = useMemo(() => {
    const highlight = rows.length <= MAX_HIGHLIGHTED_DIFF_ROWS;
    return rows.map((row) => (
      row.kind === "collapsed" ? "" : highlightReviewLine(diff.path, row.text, highlight)
    ));
  }, [diff.path, rows]);
  if (!diff.content) {
    return <div className="git-diff-placeholder">{copy.diffEmpty}</div>;
  }
  return (
    <div className="git-diff-scroll">
      {diff.truncated && <div className="git-diff-warning">{copy.truncated}</div>}
      <div className="review-code-frame">
        <div className="review-diff-lines" role="table" aria-label="File diff">
          {rows.map((row, index) => row.kind === "collapsed" ? (
            <div className="review-diff-collapsed" role="row" key={`collapsed-${index}`}>
              <span className="review-diff-fold-icon" aria-hidden="true">
                <SvgIcon name="chevronUp" size={12} />
                <SvgIcon name="chevronDown" size={12} />
              </span>
              <span>{copy.unchangedLines(formatReviewCount(row.hiddenLines, language))}</span>
            </div>
          ) : (
            <div className={"review-diff-line review-diff-line-" + row.kind} role="row" key={index}>
              <span className="review-diff-number" aria-hidden="true">{row.newLine ?? row.oldLine ?? ""}</span>
              <span className="review-diff-rail" aria-hidden="true" />
              <code
                className="hljs"
                dangerouslySetInnerHTML={{ __html: highlightedRows[index] || " " }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewFileStepper({
  copy,
  language,
  selectedIndex,
  fileCount,
  onMove,
}: {
  copy: GitCopy;
  language: Language;
  selectedIndex: number;
  fileCount: number;
  onMove: (offset: number) => void;
}) {
  return (
    <div className="git-file-stepper" aria-label={copy.changes}>
      <button
        type="button"
        aria-label={copy.previousFile}
        title={copy.previousFile}
        disabled={selectedIndex <= 0}
        onClick={() => onMove(-1)}
      >
        <SvgIcon name="chevronLeft" size={13} />
      </button>
      <span>
        {formatReviewCount(selectedIndex + 1, language)} / {formatReviewCount(fileCount, language)}
      </span>
      <button
        type="button"
        aria-label={copy.nextFile}
        title={copy.nextFile}
        disabled={selectedIndex < 0 || selectedIndex >= fileCount - 1}
        onClick={() => onMove(1)}
      >
        <SvgIcon name="chevronRight" size={13} />
      </button>
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

type ReviewFilter = "all" | "conflicted";
type ReviewProvider = "git" | "local-ledger" | "unavailable";

type ReviewTreeFolder = {
  name: string;
  path: string;
  files: ReviewFile[];
  folders: ReviewTreeFolder[];
  fileCount: number;
  additions: number;
  deletions: number;
};

const REVIEW_FILES_WIDTH_KEY = "somniq.review.files-width";
const DEFAULT_REVIEW_FILES_WIDTH = 360;
const MIN_REVIEW_FILES_WIDTH = 240;
const MAX_REVIEW_FILES_WIDTH = 720;
const LARGE_REVIEW_FILE_COUNT = 100;
const LARGE_REVIEW_LINE_COUNT = 5_000;
const REVIEW_PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const REVIEW_NUMBER_FORMATTERS: Record<Language, Intl.NumberFormat> = {
  cn: new Intl.NumberFormat("zh-CN"),
  en: new Intl.NumberFormat("en-US"),
};

function storedReviewFilesWidth(): number {
  try {
    const value = Number.parseInt(window.localStorage?.getItem(REVIEW_FILES_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(value)
      ? Math.min(MAX_REVIEW_FILES_WIDTH, Math.max(MIN_REVIEW_FILES_WIDTH, value))
      : DEFAULT_REVIEW_FILES_WIDTH;
  } catch {
    return DEFAULT_REVIEW_FILES_WIDTH;
  }
}

function formatReviewCount(value: number, language: Language): string {
  return REVIEW_NUMBER_FORMATTERS[language].format(value);
}

function finalizeReviewFolder(folder: ReviewTreeFolder): ReviewTreeFolder {
  folder.folders = folder.folders
    .map(finalizeReviewFolder)
    .sort((left, right) => REVIEW_PATH_COLLATOR.compare(left.name, right.name));
  folder.files.sort((left, right) => REVIEW_PATH_COLLATOR.compare(basename(left.path), basename(right.path)));
  folder.fileCount = folder.files.length + folder.folders.reduce((total, child) => total + child.fileCount, 0);
  folder.additions = folder.files.reduce((total, file) => total + file.additions, 0)
    + folder.folders.reduce((total, child) => total + child.additions, 0);
  folder.deletions = folder.files.reduce((total, file) => total + file.deletions, 0)
    + folder.folders.reduce((total, child) => total + child.deletions, 0);
  return folder;
}

function compactReviewFolder(folder: ReviewTreeFolder): ReviewTreeFolder {
  let compacted = {
    ...folder,
    folders: folder.folders.map(compactReviewFolder),
  };
  while (compacted.files.length === 0 && compacted.folders.length === 1) {
    const child = compacted.folders[0];
    compacted = {
      ...child,
      name: `${compacted.name}/${child.name}`,
    };
  }
  return compacted;
}

export function buildReviewFileTree(files: ReviewFile[]): ReviewTreeFolder {
  const root: ReviewTreeFolder = {
    name: "",
    path: "",
    files: [],
    folders: [],
    fileCount: 0,
    additions: 0,
    deletions: 0,
  };
  const foldersByPath = new Map<string, ReviewTreeFolder>([["", root]]);

  for (const file of files) {
    const parts = file.path.replace(/\\/g, "/").split("/").filter(Boolean);
    const folderParts = parts.slice(0, -1);
    let parent = root;
    let parentPath = "";
    for (const part of folderParts) {
      const path = parentPath ? `${parentPath}/${part}` : part;
      let folder = foldersByPath.get(path);
      if (!folder) {
        folder = {
          name: part,
          path,
          files: [],
          folders: [],
          fileCount: 0,
          additions: 0,
          deletions: 0,
        };
        foldersByPath.set(path, folder);
        parent.folders.push(folder);
      }
      parent = folder;
      parentPath = path;
    }
    parent.files.push(file);
  }

  finalizeReviewFolder(root);
  root.folders = root.folders.map(compactReviewFolder);
  return finalizeReviewFolder(root);
}

function reviewFolderPaths(folders: ReviewTreeFolder[]): string[] {
  return folders.flatMap((folder) => [folder.path, ...reviewFolderPaths(folder.folders)]);
}

function ancestorFolderPaths(path: string): string[] {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean).slice(0, -1);
  if (parts.length === 0) return ["."];
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function filterMatches(file: ReviewFile, filter: ReviewFilter): boolean {
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
  const [groupVisibility, setGroupVisibility] = useState<Record<string, boolean>>({});
  const [filesPaneWidth, setFilesPaneWidth] = useState(storedReviewFilesWidth);
  const [filesPaneOpen, setFilesPaneOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const fileButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const refreshInFlight = useRef(false);
  const mutationInFlight = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

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
    setGroupVisibility({});
    void refresh();
  }, [currentProject?.id, refresh]);

  useEffect(() => {
    try {
      window.localStorage?.setItem(REVIEW_FILES_WIDTH_KEY, String(filesPaneWidth));
    } catch {
      // The review layout remains usable when browser storage is unavailable.
    }
  }, [filesPaneWidth]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

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

  const reviewTree = useMemo(() => buildReviewFileTree(filteredFiles), [filteredFiles]);
  const reviewTreeFolders = useMemo<ReviewTreeFolder[]>(() => {
    if (reviewTree.files.length === 0) return reviewTree.folders;
    const rootFiles = reviewTree.files;
    return [{
      name: copy.rootFiles,
      path: ".",
      files: rootFiles,
      folders: [],
      fileCount: rootFiles.length,
      additions: rootFiles.reduce((total, file) => total + file.additions, 0),
      deletions: rootFiles.reduce((total, file) => total + file.deletions, 0),
    }, ...reviewTree.folders];
  }, [copy.rootFiles, reviewTree]);

  const filterCounts = useMemo<Record<ReviewFilter, number>>(() => ({
    all: files.length,
    conflicted: files.filter((file) => file.conflicted).length,
  }), [files]);

  useEffect(() => {
    if (selectedPath && filteredFiles.some((file) => file.path === selectedPath)) return;
    setSelectedPath(filteredFiles[0]?.path ?? null);
  }, [filteredFiles, selectedPath]);

  const selectedChange = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const selectedIndex = useMemo(
    () => filteredFiles.findIndex((file) => file.path === selectedPath),
    [filteredFiles, selectedPath],
  );

  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = ancestorFolderPaths(selectedPath);
    setGroupVisibility((current) => ({
      ...current,
      ...Object.fromEntries(ancestors.map((path) => [path, true])),
    }));
  }, [selectedPath]);

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
  const largeReview = files.length >= LARGE_REVIEW_FILE_COUNT
    || totals.additions + totals.deletions >= LARGE_REVIEW_LINE_COUNT;

  const selectChange = (change: ReviewFile) => {
    setSelectedPath(change.path);
    const ancestors = ancestorFolderPaths(change.path);
    setGroupVisibility((current) => ({
      ...current,
      ...Object.fromEntries(ancestors.map((path) => [path, true])),
    }));
    if (!change.local) {
      const gitChange = snapshot?.files.find((file) => file.path === change.path);
      if (gitChange) setDiffMode(preferredDiffMode(gitChange));
    } else {
      setDiffMode("working");
    }
    setError(null);
  };

  const folderContainsSelection = (folder: ReviewTreeFolder): boolean => {
    if (!selectedPath) return false;
    const normalized = selectedPath.replace(/\\/g, "/");
    return folder.path === "."
      ? !normalized.includes("/")
      : normalized.startsWith(`${folder.path}/`);
  };

  const folderIsExpanded = (folder: ReviewTreeFolder): boolean => {
    if (search.trim()) return true;
    if (Object.prototype.hasOwnProperty.call(groupVisibility, folder.path)) {
      return groupVisibility[folder.path];
    }
    return folderContainsSelection(folder);
  };

  const toggleFolder = (folder: ReviewTreeFolder) => {
    const next = !folderIsExpanded(folder);
    setGroupVisibility((current) => ({ ...current, [folder.path]: next }));
  };

  const setAllFoldersExpanded = (expanded: boolean) => {
    setGroupVisibility(Object.fromEntries(
      reviewFolderPaths(reviewTreeFolders).map((path) => [path, expanded]),
    ));
  };

  const moveSelection = (offset: number, moveFocus = false) => {
    if (filteredFiles.length === 0) return;
    const from = selectedIndex < 0 ? 0 : selectedIndex;
    const nextIndex = Math.min(filteredFiles.length - 1, Math.max(0, from + offset));
    const next = filteredFiles[nextIndex];
    if (!next) return;
    selectChange(next);
    if (moveFocus) {
      window.setTimeout(() => fileButtonRefs.current.get(next.path)?.focus(), 0);
    }
  };

  const onFileListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1, true);
  };

  const beginFilesResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const layout = layoutRef.current;
    if (!layout) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = filesPaneWidth;
    const maxWidth = Math.min(
      MAX_REVIEW_FILES_WIDTH,
      Math.max(MIN_REVIEW_FILES_WIDTH, layout.getBoundingClientRect().width - 360),
    );
    const move = (moveEvent: PointerEvent) => {
      setFilesPaneWidth(Math.min(maxWidth, Math.max(
        MIN_REVIEW_FILES_WIDTH,
        startWidth - (moveEvent.clientX - startX),
      )));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      document.body.classList.remove("somniq-resizing-col");
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    document.body.classList.add("somniq-resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup, { once: true });
  };

  const onFilesResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      setFilesPaneWidth(DEFAULT_REVIEW_FILES_WIDTH);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? 16 : -16;
    setFilesPaneWidth((current) => Math.min(
      MAX_REVIEW_FILES_WIDTH,
      Math.max(MIN_REVIEW_FILES_WIDTH, current + delta),
    ));
  };

  const openNativeDiff = () => {
    if (!currentProject || !selectedChange || selectedChange.local || provider !== "git") return;
    setPendingCodeDiff({
      path: absoluteProjectPath(currentProject.path, selectedChange.path),
      staged: diffMode === "staged",
    });
    setTab("lab");
  };

  const renderReviewFile = (change: ReviewFile, depth: number): ReactNode => (
    <div
      className={"git-file-row" + (selectedPath === change.path ? " selected" : "")}
      key={change.path}
      role="treeitem"
      aria-level={depth + 1}
      style={{ "--review-tree-depth": depth } as CSSProperties}
    >
      <button
        className="git-file-select"
        type="button"
        ref={(node) => {
          if (node) fileButtonRefs.current.set(change.path, node);
          else fileButtonRefs.current.delete(change.path);
        }}
        aria-label={change.path}
        aria-pressed={selectedPath === change.path}
        title={change.path}
        onClick={() => selectChange(change)}
      >
        <SvgIcon name="document" size={14} />
        <span className="git-file-copy">
          <span className="git-file-name">{basename(change.path)}</span>
          {change.oldPath && <span className="git-file-dir">← {change.oldPath}</span>}
        </span>
        <span className="git-file-badges">
          {(change.additions > 0 || change.deletions > 0) && (
            <span className="git-file-stats">
              {change.additions > 0 && <span className="git-file-additions">+{formatReviewCount(change.additions, language)}</span>}
              {change.deletions > 0 && <span className="git-file-deletions">-{formatReviewCount(change.deletions, language)}</span>}
            </span>
          )}
          <span className={"git-status-badge" + (change.conflicted ? " danger" : "")}>{change.kind}</span>
          {change.staged && <span className="git-status-badge staged">{copy.stagedBadge}</span>}
        </span>
      </button>
    </div>
  );

  const renderReviewFolder = (folder: ReviewTreeFolder, depth: number): ReactNode => {
    const expanded = folderIsExpanded(folder);
    const folderLabel = folder.path === "." ? copy.rootFiles : folder.path;
    return (
      <section
        className="git-file-group git-tree-folder"
        key={folder.path}
        role="treeitem"
        aria-expanded={expanded}
        aria-level={depth + 1}
        aria-label={folderLabel}
      >
        <div
          className="git-file-group-heading"
          style={{ "--review-tree-depth": depth } as CSSProperties}
        >
          <button
            type="button"
            aria-expanded={expanded}
            title={folderLabel}
            onClick={() => toggleFolder(folder)}
          >
            <SvgIcon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
            <SvgIcon name="folder" size={13} />
            <span className="git-file-group-name">{folder.name}</span>
            <span className="git-file-group-count">{formatReviewCount(folder.fileCount, language)}</span>
            {(folder.additions > 0 || folder.deletions > 0) && (
              <span className="git-file-stats" aria-hidden="true">
                {folder.additions > 0 && <span className="git-file-additions">+{formatReviewCount(folder.additions, language)}</span>}
                {folder.deletions > 0 && <span className="git-file-deletions">-{formatReviewCount(folder.deletions, language)}</span>}
              </span>
            )}
          </button>
        </div>
        {expanded && (
          <div className="git-file-tree-children" role="group">
            {folder.folders.map((child) => renderReviewFolder(child, depth + 1))}
            {folder.files.map((file) => renderReviewFile(file, depth + 1))}
          </div>
        )}
      </section>
    );
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
          <span className="git-review-stat"><strong>{formatReviewCount(files.length, language)}</strong> {copy.changes}</span>
          {totals.additions > 0 && (
            <span className="git-review-stat git-review-additions">+{formatReviewCount(totals.additions, language)}</span>
          )}
          {totals.deletions > 0 && (
            <span className="git-review-stat git-review-deletions">-{formatReviewCount(totals.deletions, language)}</span>
          )}
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
          <SvgIcon name="refresh" size={13} />
          <span>{copy.refresh}</span>
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
        <div
          className={`git-layout${filesPaneOpen ? "" : " files-collapsed"}`}
          ref={layoutRef}
          style={{ "--review-files-width": `${filesPaneWidth}px` } as CSSProperties}
        >
          <aside className="git-sidebar" aria-hidden={!filesPaneOpen}>
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
                <span className="git-files-heading-actions">
                  <span>{formatReviewCount(filteredFiles.length, language)} / {formatReviewCount(files.length, language)}</span>
                  <button
                    className="git-files-pane-collapse"
                    type="button"
                    aria-label={copy.collapseFiles}
                    title={copy.collapseFiles}
                    onClick={() => setFilesPaneOpen(false)}
                  >
                    <SvgIcon name="chevronRight" size={13} />
                  </button>
                </span>
              </div>
              <label className="git-file-search">
                <SvgIcon name="search" size={13} />
                <input
                  type="search"
                  value={search}
                  placeholder={copy.searchFiles}
                  aria-label={copy.searchFiles}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && search) {
                      event.preventDefault();
                      setSearch("");
                    }
                  }}
                />
                {search && (
                  <button
                    type="button"
                    aria-label={copy.clearSearch}
                    title={copy.clearSearch}
                    onClick={() => setSearch("")}
                  >
                    <SvgIcon name="close" size={12} />
                  </button>
                )}
              </label>
              <div className="git-filter-list" role="group" aria-label={copy.changes}>
                {([
                  ["all", copy.filterAll],
                  ["conflicted", copy.filterConflicted],
                ] as const).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={filter === value ? "active" : ""}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    <span>{label}</span>
                    <strong>{formatReviewCount(filterCounts[value], language)}</strong>
                  </button>
                ))}
              </div>
              <div className="git-list-actions">
                <div className="git-tree-actions">
                  <button
                    type="button"
                    aria-label={copy.expandAll}
                    title={copy.expandAll}
                    disabled={reviewTreeFolders.length === 0 || Boolean(search.trim())}
                    onClick={() => setAllFoldersExpanded(true)}
                  >
                    <SvgIcon name="chevronDown" size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={copy.collapseAll}
                    title={copy.collapseAll}
                    disabled={reviewTreeFolders.length === 0 || Boolean(search.trim())}
                    onClick={() => setAllFoldersExpanded(false)}
                  >
                    <SvgIcon name="chevronUp" size={13} />
                  </button>
                </div>
              </div>
              <div
                className="git-file-list review-file-list"
                role="tree"
                aria-label={copy.changes}
                onKeyDown={onFileListKeyDown}
              >
                {filteredFiles.length === 0 && (
                  <p className="git-clean">{files.length === 0 ? copy.noChanges : copy.noMatches}</p>
                )}
                {reviewTreeFolders.map((folder) => renderReviewFolder(folder, 0))}
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

          <div
            className="git-layout-resizer"
            role="separator"
            tabIndex={filesPaneOpen ? 0 : -1}
            aria-hidden={!filesPaneOpen}
            aria-label={copy.resizeFiles}
            aria-orientation="vertical"
            aria-valuemin={MIN_REVIEW_FILES_WIDTH}
            aria-valuemax={MAX_REVIEW_FILES_WIDTH}
            aria-valuenow={filesPaneWidth}
            title={`${copy.resizeFiles} · ${copy.resetFilesWidth}`}
            onPointerDown={beginFilesResize}
            onDoubleClick={() => setFilesPaneWidth(DEFAULT_REVIEW_FILES_WIDTH)}
            onKeyDown={onFilesResizeKeyDown}
          />

          <main className="git-diff-pane">
            {selectedChange ? (
              <>
                {largeReview && (
                  <div className="git-large-review-notice" role="note">
                    <span className="git-large-review-message">
                      <SvgIcon name="info" size={14} />
                      <strong>{copy.largeReview}</strong>
                    </span>
                    <ReviewFileStepper
                      copy={copy}
                      language={language}
                      selectedIndex={selectedIndex}
                      fileCount={filteredFiles.length}
                      onMove={moveSelection}
                    />
                  </div>
                )}
                <div className="git-diff-header">
                  <div className="git-diff-title-wrap">
                    <SvgIcon name="document" size={14} />
                    <div className="git-diff-title" title={selectedChange.path}>{selectedChange.path}</div>
                    {(selectedChange.additions > 0 || selectedChange.deletions > 0) && (
                      <span className="git-diff-file-stats" aria-label={`${selectedChange.additions} additions, ${selectedChange.deletions} deletions`}>
                        {selectedChange.additions > 0 && <span className="git-file-additions">+{formatReviewCount(selectedChange.additions, language)}</span>}
                        {selectedChange.deletions > 0 && <span className="git-file-deletions">-{formatReviewCount(selectedChange.deletions, language)}</span>}
                      </span>
                    )}
                    <span className="git-status-badge">{selectedChange.kind}</span>
                    {selectedChange.local && <span className="git-status-badge staged">{copy.aiChange}</span>}
                  </div>
                  <div className="git-diff-actions">
                    {!filesPaneOpen && (
                      <button
                        className="git-files-pane-expand"
                        type="button"
                        aria-label={copy.expandFiles}
                        title={copy.expandFiles}
                        onClick={() => setFilesPaneOpen(true)}
                      >
                        <SvgIcon name="folder" size={13} />
                        <span>{copy.changes}</span>
                        <SvgIcon name="chevronLeft" size={12} />
                      </button>
                    )}
                    {!largeReview && (
                      <ReviewFileStepper
                        copy={copy}
                        language={language}
                        selectedIndex={selectedIndex}
                        fileCount={filteredFiles.length}
                        onMove={moveSelection}
                      />
                    )}
                    {provider === "git" && (
                      <button
                        className="git-button ghost"
                        type="button"
                        aria-label={copy.openInCode}
                        title={copy.nativeDiffHint}
                        disabled={!currentProject || busy}
                        onClick={openNativeDiff}
                      >
                        <SvgIcon name="code" size={13} />
                        <span>{copy.openInCode}</span>
                      </button>
                    )}
                    {provider === "git" && selectedChange.staged && (selectedChange.unstaged || selectedChange.untracked) && (
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
                {renderedDiff ? <DiffViewer diff={renderedDiff} copy={copy} language={language} /> : (
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
