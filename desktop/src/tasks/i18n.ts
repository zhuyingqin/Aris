import type { Language } from "../store";
import type { BoardColumnId } from "./boardColumns";
import type { WorkTaskStatus } from "../types";

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
    cancel: string;
    save: string;
    empty: string;
    emptyHint: string;
    columns: Record<BoardColumnId, string>;
    columnEmpty: Record<BoardColumnId, string>;
    statuses: Record<WorkTaskStatus, string>;
    start: string;
    retry: string;
    stop: string;
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
      "每个任务在独立的 Git 工作树里执行，完成后你审阅差异，接受时才合并回当前分支。",
    newTask: "新建任务",
    allProjects: "当前项目",
    draftHint: "任务会在独立工作树中无人值守执行，并在完成后等待你验收。",
    titleLabel: "标题",
    titleHint: "需要完成什么？",
    promptLabel: "任务说明",
    promptHint: "描述要完成的工作。执行时无人值守，写清楚判断依据比留问题更有用。",
    create: "创建",
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
      review: "待确认",
      merging: "合并中",
      done: "已完成",
      failed: "失败",
      canceled: "已取消",
    },
    start: "开始",
    retry: "重试",
    stop: "停止",
    accept: "接受并合并",
    accepting: "正在合并…",
    returnToTodo: "退回待办",
    edit: "编辑",
    delete: "删除",
    deleteConfirm: (title) => `删除任务「${title}」及其工作树？`,
    viewDiff: "查看差异",
    hideDiff: "收起差异",
    changesSummary: (files, additions, deletions) =>
      `${files} 个文件 · +${additions} −${deletions}`,
    noChanges: "没有产生任何改动",
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
      "Each task runs in its own Git worktree. You review the diff, and nothing reaches your branch until you accept it.",
    newTask: "New task",
    allProjects: "Current project",
    draftHint: "The task runs unattended in an isolated worktree and waits for your review when it finishes.",
    titleLabel: "Title",
    titleHint: "What needs to be done?",
    promptLabel: "Instructions",
    promptHint:
      "Describe the work. It runs unattended, so stating how to decide beats leaving a question.",
    create: "Create",
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
      review: "In review",
      merging: "Merging",
      done: "Done",
      failed: "Failed",
      canceled: "Canceled",
    },
    start: "Start",
    retry: "Retry",
    stop: "Stop",
    accept: "Accept and merge",
    accepting: "Merging...",
    returnToTodo: "Return to to-do",
    edit: "Edit",
    delete: "Delete",
    deleteConfirm: (title) => `Delete the task "${title}" and its worktree?`,
    viewDiff: "View diff",
    hideDiff: "Hide diff",
    changesSummary: (files, additions, deletions) =>
      `${files} file${files === 1 ? "" : "s"} · +${additions} −${deletions}`,
    noChanges: "No changes were produced",
    branchLabel: "Branch",
    mergedAs: (commit) => `Merged as ${commit.slice(0, 8)}`,
    loading: "Loading tasks...",
    showCanceled: "Show canceled",
    defaultAgent: "Use Chat model",
    openChat: "Open chat",
  },
};
