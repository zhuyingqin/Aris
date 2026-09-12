import type { Language } from "../store";
import type { BoardColumnId } from "./boardColumns";
import type { WorkTaskEmptyReason, WorkTaskStatus, WorkTaskVerdict } from "../types";

/**
 * Copy for the review panel.
 *
 * `empty` is the point of the whole thing: five different outcomes used to
 * share one sentence, and the one it used to say — "no changes were produced"
 * — is right for exactly one of them and actively misleading for the rest.
 */
export const REVIEW_COPY: Record<
  Language,
  {
    loading: string;
    fileCount: (files: number) => string;
    binary: string;
    binaryNote: string;
    noPatch: string;
    artifacts: string;
    artifactsNote: string;
    export: string;
    exportAgain: string;
    exportedTo: (path: string) => string;
    verdict: Record<WorkTaskVerdict, string>;
    reviewedBy: (model: string) => string;
    exhausted: (rounds: number) => string;
    empty: Record<WorkTaskEmptyReason, string>;
  }
> = {
  cn: {
    loading: "正在读取结果…",
    fileCount: (files) => `${files} 个文件`,
    binary: "二进制",
    binaryNote: "这是二进制文件，没有可读的文本差异。合并后可以在项目里直接打开。",
    noPatch: "这个文件没有文本差异。",
    artifacts: "独立交付物",
    artifactsNote: "不进仓库，不受合并影响",
    export: "导出…",
    exportAgain: "再导出…",
    exportedTo: (path) => `已导出到 ${path}`,
    verdict: {
      pass: "独立审查通过",
      revise: "独立审查要求修改",
      needs_user: "需要你来判断",
      unavailable: "没有经过独立审查",
    },
    reviewedBy: (model) => `审查者：${model}`,
    exhausted: (rounds) => `已用完 ${rounds} 轮修改，下面这些问题仍然存在，请你自己判断。`,
    empty: {
      no_repository_changes: "任务跑完了，但没有改动任何文件——它可能只是读取和分析。会话里有它的结论。",
      artifacts_only: "没有改动仓库文件，但产出了独立交付物，在下面单独审阅。",
      nothing_produced: "这次运行没有产出任何东西。",
      worktree_missing: "任务的工作树已经不在磁盘上了，结果无法读取——这不代表它没做出东西。",
      snapshot_failed: "读取结果时出错，详见卡片上的错误信息。",
    },
  },
  en: {
    loading: "Reading the result...",
    fileCount: (files) => `${files} file${files === 1 ? "" : "s"}`,
    binary: "binary",
    binaryNote:
      "A binary file, so there is no readable text diff. Open it in the project once this is merged.",
    noPatch: "This file has no text differences.",
    artifacts: "Deliverables",
    artifactsNote: "not in the repository, unaffected by merging",
    export: "Export...",
    exportAgain: "Export again...",
    exportedTo: (path) => `Saved to ${path}`,
    verdict: {
      pass: "Passed independent review",
      revise: "Independent review asked for changes",
      needs_user: "Needs your judgement",
      unavailable: "Not independently reviewed",
    },
    reviewedBy: (model) => `Reviewed by ${model}`,
    exhausted: (rounds) =>
      `${rounds} revision rounds were spent and these are still outstanding — your call.`,
    empty: {
      no_repository_changes:
        "The task ran but changed no files — it may have only read and analysed. Its conclusion is in the transcript.",
      artifacts_only:
        "No repository files changed, but standalone deliverables were produced and are reviewed separately below.",
      nothing_produced: "This run produced nothing at all.",
      worktree_missing:
        "The task's worktree is gone from disk, so the result cannot be read — which is not the same as it having produced nothing.",
      snapshot_failed: "Reading the result failed; the card carries the error.",
    },
  },
};

export const TASKS_COPY: Record<
  Language,
  {
    title: string;
    subtitle: string;
    newTask: string;
    allProjects: string;
    draftHint: string;
    titleLabel: string;
    titleHint: string;
    promptLabel: string;
    promptHint: string;
    create: string;
    createAndStart: string;
    saveOnly: string;
    cancel: string;
    save: string;
    empty: string;
    emptyHint: string;
    columns: Record<BoardColumnId, string>;
    columnEmpty: Record<BoardColumnId, string>;
    statuses: Record<WorkTaskStatus, string>;
    start: string;
    retry: string;
    resume: string;
    pause: string;
    stop: string;
    answerLabel: string;
    answerHint: string;
    answerSend: string;
    heartbeatFresh: (age: string) => string;
    heartbeatStale: string;
    accept: string;
    accepting: string;
    returnToTodo: string;
    edit: string;
    delete: string;
    deleteConfirm: (title: string) => string;
    viewDiff: string;
    hideDiff: string;
    changesSummary: (files: number, additions: number, deletions: number) => string;
    noChanges: string;
    noFileChanges: string;
    artifactCount: (count: number) => string;
    resultUnreadable: string;
    branchLabel: string;
    mergedAs: (commit: string) => string;
    loading: string;
    showCanceled: string;
    defaultAgent: string;
    openChat: string;
  }
> = {
  cn: {
    title: "待办任务",
    subtitle:
      "每个任务在独立的 Git 工作树里执行；你接受差异后自动落地，遇到冲突由合并 Agent 接手。",
    newTask: "新建任务",
    allProjects: "当前项目",
    draftHint: "任务会在独立工作树中无人值守执行，并在完成后等待你验收。",
    titleLabel: "标题",
    titleHint: "需要完成什么？",
    promptLabel: "任务说明",
    promptHint: "描述要完成的工作。执行时无人值守，写清楚判断依据比留问题更有用。",
    create: "创建",
    createAndStart: "创建并开始",
    saveOnly: "仅保存到待办",
    cancel: "取消",
    save: "保存",
    empty: "还没有任务",
    emptyHint: "新建一个任务，它会在独立工作树里执行；你审阅完差异再决定是否合并。",
    columns: {
      todo: "待办",
      inProgress: "进行中",
      attention: "待确认",
      done: "已完成",
    },
    columnEmpty: {
      todo: "没有等待开始的任务",
      inProgress: "当前没有任务在执行",
      attention: "没有待确认的任务",
      done: "还没有完成的任务",
    },
    statuses: {
      todo: "待办",
      queued: "排队中",
      preparing: "准备工作树",
      running: "执行中",
      pausing: "正在停下",
      paused: "已暂停",
      awaiting_input: "等待你回答",
      reviewing: "独立审查中",
      revising: "按审查意见修改中",
      review: "待确认",
      merging: "Agent 合并中",
      interrupted: "已中断",
      done: "已完成",
      failed: "失败",
      canceled: "已取消",
    },
    start: "开始",
    retry: "重试",
    resume: "继续",
    pause: "暂停",
    stop: "停止",
    answerLabel: "任务需要你决定",
    answerHint: "选一个，或者直接写你的答复。",
    answerSend: "回答",
    heartbeatFresh: (age) => `${age}前还有动静`,
    heartbeatStale: "已经一段时间没有动静了",
    accept: "接受并合并",
    accepting: "正在检查并合并…",
    returnToTodo: "退回待办",
    edit: "编辑",
    delete: "删除",
    deleteConfirm: (title) => `删除任务「${title}」及其工作树？`,
    viewDiff: "查看差异",
    hideDiff: "收起差异",
    changesSummary: (files, additions, deletions) =>
      `${files} 个文件 · +${additions} −${deletions}`,
    noChanges: "没有产生任何改动",
    noFileChanges: "没有改动仓库文件（结论在会话里）",
    artifactCount: (count) => `${count} 个交付物`,
    resultUnreadable: "结果无法读取（工作树已不在）",
    branchLabel: "分支",
    mergedAs: (commit) => `已合并为 ${commit.slice(0, 8)}`,
    loading: "正在读取任务…",
    showCanceled: "显示已取消",
    defaultAgent: "继承 Chat 模型",
    openChat: "查看会话",
  },
  en: {
    title: "Work tasks",
    subtitle:
      "Each task runs in its own Git worktree. After you accept the diff, clean merges land directly and conflicts go to a merge Agent.",
    newTask: "New task",
    allProjects: "Current project",
    draftHint: "The task runs unattended in an isolated worktree and waits for your review when it finishes.",
    titleLabel: "Title",
    titleHint: "What needs to be done?",
    promptLabel: "Instructions",
    promptHint:
      "Describe the work. It runs unattended, so stating how to decide beats leaving a question.",
    create: "Create",
    createAndStart: "Create and start",
    saveOnly: "Save to to-do only",
    cancel: "Cancel",
    save: "Save",
    empty: "No tasks yet",
    emptyHint:
      "Create a task and it runs in an isolated worktree; you review the diff before anything merges.",
    columns: {
      todo: "To do",
      inProgress: "In progress",
      attention: "Needs you",
      done: "Done",
    },
    columnEmpty: {
      todo: "Nothing waiting to start",
      inProgress: "Nothing in progress",
      attention: "Nothing needs your attention",
      done: "Nothing completed yet",
    },
    statuses: {
      todo: "To do",
      queued: "Queued",
      preparing: "Preparing worktree",
      running: "Running",
      pausing: "Stopping",
      paused: "Paused",
      awaiting_input: "Waiting for you",
      reviewing: "Independent review",
      revising: "Addressing review",
      review: "In review",
      merging: "Agent merging",
      interrupted: "Interrupted",
      done: "Done",
      failed: "Failed",
      canceled: "Canceled",
    },
    start: "Start",
    retry: "Retry",
    resume: "Resume",
    pause: "Pause",
    stop: "Stop",
    answerLabel: "This task needs you to decide",
    answerHint: "Pick one, or write your own answer.",
    answerSend: "Answer",
    heartbeatFresh: (age) => `active ${age} ago`,
    heartbeatStale: "no sign of activity for a while",
    accept: "Accept and merge",
    accepting: "Checking and merging...",
    returnToTodo: "Return to to-do",
    edit: "Edit",
    delete: "Delete",
    deleteConfirm: (title) => `Delete the task "${title}" and its worktree?`,
    viewDiff: "View diff",
    hideDiff: "Hide diff",
    changesSummary: (files, additions, deletions) =>
      `${files} file${files === 1 ? "" : "s"} · +${additions} −${deletions}`,
    noChanges: "No changes were produced",
    noFileChanges: "No repository files changed (conclusion is in the transcript)",
    artifactCount: (count) => `${count} deliverable${count === 1 ? "" : "s"}`,
    resultUnreadable: "Result cannot be read (worktree is gone)",
    branchLabel: "Branch",
    mergedAs: (commit) => `Merged as ${commit.slice(0, 8)}`,
    loading: "Loading tasks...",
    showCanceled: "Show canceled",
    defaultAgent: "Use Chat model",
    openChat: "Open chat",
  },
};
