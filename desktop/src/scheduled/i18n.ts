import type { Language } from "../store";
import type { ScheduledTaskInput } from "../types";

export type IntervalUnit = ScheduledTaskInput["intervalUnit"];
export type TriggerKind = NonNullable<ScheduledTaskInput["triggerKind"]>;

export interface TaskTemplate {
  id: string;
  label: string;
  description: string;
  title: string;
  prompt: string;
  triggerKind: TriggerKind;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  mailKeywords?: string;
}

const DEFAULT_INTERVAL = 15;

export const SCHEDULED_TASKS_COPY: Record<Language, {
  unitLabels: Record<IntervalUnit, string>;
  taskTemplates: TaskTemplate[];
  noValue: string;
  paused: string;
  lastRunFailed: string;
  lastRunAt: (time: string) => string;
  waitingForMail: string;
  nextRunAt: (time: string) => string;
  waitingFirstRun: string;
  mailTrigger: string;
  intervalTrigger: string;
  sessionFallbackTitle: (id: string) => string;
  unboundSession: string;
  followCurrentModel: string;
  everyInterval: (value: number, unitLabel: string) => string;
  untitledTask: string;
  start: string;
  pause: string;
  viewSessionTitle: string;
  onNewMail: string;
  currentModelOption: string;
  previewModelLabel: string;
  previewModelDescription: string;
  tabsAriaLabel: string;
  tabTasks: string;
  tabTemplates: string;
  heading: string;
  subheading: string;
  searchPlaceholder: string;
  loading: string;
  emptyTasksTitle: string;
  activeGroup: string;
  groupEmpty: string;
  backToChat: string;
  createTask: string;
  refreshAriaLabel: string;
  selectOrCreate: string;
  needSavedChat: string;
  titlePlaceholder: string;
  promptPlaceholder: string;
  detailsSection: string;
  environmentLabel: string;
  environmentInfo: string;
  workspaceValue: string;
  projectLabel: string;
  currentProjectFallback: string;
  boundChatLabel: string;
  selectChatPlaceholder: string;
  triggerLabel: string;
  triggerIntervalOption: string;
  repeatCountLabel: string;
  everyLabel: string;
  triggerAccountLabel: string;
  anyConnectedMailbox: string;
  keywordsLabel: string;
  keywordsPlaceholder: string;
  modelFieldLabel: string;
  statusLabel: string;
  statusGroupAriaLabel: string;
  runPanelTriggerLabel: string;
  nextRunLabel: string;
  lastRunLabel: string;
  lastErrorLabel: string;
  noErrorValue: string;
  saveButton: string;
  viewChatButton: string;
  deleteButton: string;
  deleteConfirm: (title: string) => string;
}> = {
  cn: {
    unitLabels: {
      minutes: "分钟",
      hours: "小时",
      days: "天",
    },
    taskTemplates: [
      {
        id: "literature-mail-on-arrival",
        label: "新邮件触发·论文求助回复",
        description: "收到含「文献求助/论文求助」等关键词的新邮件时，自动检索并回复 PDF。",
        title: "新邮件·论文求助自动回复",
        prompt:
          "有一封新邮件触发了本任务（邮件信息见末尾）。先用 mail_read 读取该邮件确认是文献/论文求助，然后调用 mail_literature_catch_up（可只针对该账户）完成检索、下载 PDF，并按「设置 > 邮件自动化」配置回复。最后用一句话汇总处理结果；若不是求助邮件则跳过，不要编造。",
        triggerKind: "mail",
        intervalValue: DEFAULT_INTERVAL,
        intervalUnit: "minutes",
        mailKeywords: "文献求助, 论文求助, paper request, literature request",
      },
      {
        id: "literature-mail-poll",
        label: "定时轮询·论文求助回复",
        description: "按间隔扫描收件箱中的文献/论文求助邮件并回复 PDF。",
        title: "定时轮询·论文求助自动回复",
        prompt:
          "检查我已连接邮箱的收件箱，找出文献/论文求助类邮件。调用 mail_literature_catch_up 工具完成检索、下载 PDF，并按「设置 > 邮件自动化」的配置（来源、自动发送、白名单）回复。处理完成后用一句话汇总：本次识别了哪些求助、发送/准备了多少封回复、是否有失败。若没有连接的邮箱或没有匹配邮件，明确说明即可，不要编造。",
        triggerKind: "interval",
        intervalValue: 30,
        intervalUnit: "minutes",
      },
    ],
    noValue: "暂无",
    paused: "已暂停",
    lastRunFailed: "最近执行失败",
    lastRunAt: (time) => `上次 ${time}`,
    waitingForMail: "等待新邮件触发",
    nextRunAt: (time) => `下次 ${time}`,
    waitingFirstRun: "等待首次执行",
    mailTrigger: "邮件",
    intervalTrigger: "间隔",
    sessionFallbackTitle: (id) => `对话 ${id}`,
    unboundSession: "未绑定",
    followCurrentModel: "跟随当前模型",
    everyInterval: (value, unitLabel) => `每 ${value} ${unitLabel}`,
    untitledTask: "未命名任务",
    start: "启动",
    pause: "暂停",
    viewSessionTitle: "查看该任务运行的对话记录",
    onNewMail: "收到新邮件时",
    currentModelOption: "当前模型",
    previewModelLabel: "预览",
    previewModelDescription: "浏览器预览",
    tabsAriaLabel: "定时任务视图",
    tabTasks: "任务",
    tabTemplates: "模板",
    heading: "已安排",
    subheading: "管理周期性任务、提醒和监控",
    searchPlaceholder: "搜索已安排任务",
    loading: "加载中...",
    emptyTasksTitle: "暂无定时任务",
    activeGroup: "运行中",
    groupEmpty: "暂无",
    backToChat: "返回对话",
    createTask: "创建计划任务",
    refreshAriaLabel: "刷新定时任务",
    selectOrCreate: "选择或新建任务",
    needSavedChat: "需要一个已保存的对话",
    titlePlaceholder: "已安排任务标题",
    promptPlaceholder: "添加提示词，例如：在 $sentry 中查找崩溃",
    detailsSection: "详情",
    environmentLabel: "运行环境",
    environmentInfo: "后台任务会在当前工作树执行",
    workspaceValue: "工作树",
    projectLabel: "项目",
    currentProjectFallback: "当前项目",
    boundChatLabel: "绑定对话",
    selectChatPlaceholder: "选择对话",
    triggerLabel: "触发方式",
    triggerIntervalOption: "按时间间隔",
    repeatCountLabel: "重复次数",
    everyLabel: "每",
    triggerAccountLabel: "触发账户",
    anyConnectedMailbox: "任意已连接邮箱",
    keywordsLabel: "关键词",
    keywordsPlaceholder: "文献求助, 论文求助",
    modelFieldLabel: "模型",
    statusLabel: "状态",
    statusGroupAriaLabel: "任务状态",
    runPanelTriggerLabel: "触发",
    nextRunLabel: "下次执行",
    lastRunLabel: "上次执行",
    lastErrorLabel: "最近错误",
    noErrorValue: "无",
    saveButton: "保存",
    viewChatButton: "查看对话",
    deleteButton: "删除",
    deleteConfirm: (title) => `删除定时任务「${title}」？`,
  },
  en: {
    unitLabels: {
      minutes: "minutes",
      hours: "hours",
      days: "days",
    },
    taskTemplates: [
      {
        id: "literature-mail-on-arrival",
        label: "New mail trigger - paper request auto-reply",
        description:
          "When a new email arrives containing keywords like \"literature request/paper request\", automatically search for and reply with the PDF.",
        title: "New mail - paper request auto-reply",
        prompt:
          "A new email triggered this task (the email details are appended below). First use mail_read to read the email and confirm it is a literature/paper request, then call mail_literature_catch_up (optionally scoped to this account) to search, download the PDF, and reply per the \"Settings > Mail automation\" configuration. Finish with a one-sentence summary of the outcome; if it is not a request email, skip it - do not fabricate a result.",
        triggerKind: "mail",
        intervalValue: DEFAULT_INTERVAL,
        intervalUnit: "minutes",
        mailKeywords: "文献求助, 论文求助, paper request, literature request",
      },
      {
        id: "literature-mail-poll",
        label: "Scheduled poll - paper request auto-reply",
        description: "Periodically scan the inbox for literature/paper request emails and reply with the PDF.",
        title: "Scheduled poll - paper request auto-reply",
        prompt:
          "Check the inbox of my connected mail account(s) for literature/paper request emails. Call the mail_literature_catch_up tool to search, download the PDF, and reply per the \"Settings > Mail automation\" configuration (source, auto-send, allowlist). When done, summarize in one sentence: which requests were identified, how many replies were sent/prepared, and whether any failed. If there is no connected mailbox or no matching email, state that clearly - do not fabricate a result.",
        triggerKind: "interval",
        intervalValue: 30,
        intervalUnit: "minutes",
      },
    ],
    noValue: "None",
    paused: "Paused",
    lastRunFailed: "Last run failed",
    lastRunAt: (time) => `Last run ${time}`,
    waitingForMail: "Waiting for new mail",
    nextRunAt: (time) => `Next run ${time}`,
    waitingFirstRun: "Waiting for first run",
    mailTrigger: "Mail",
    intervalTrigger: "Interval",
    sessionFallbackTitle: (id) => `Chat ${id}`,
    unboundSession: "Unbound",
    followCurrentModel: "Follow current model",
    everyInterval: (value, unitLabel) => `Every ${value} ${unitLabel}`,
    untitledTask: "Untitled task",
    start: "Start",
    pause: "Pause",
    viewSessionTitle: "View the chat transcript this task runs in",
    onNewMail: "When new mail arrives",
    currentModelOption: "Current model",
    previewModelLabel: "Preview",
    previewModelDescription: "Browser preview",
    tabsAriaLabel: "Scheduled tasks view",
    tabTasks: "Tasks",
    tabTemplates: "Templates",
    heading: "Scheduled",
    subheading: "Manage recurring tasks, reminders, and monitoring",
    searchPlaceholder: "Search scheduled tasks",
    loading: "Loading...",
    emptyTasksTitle: "No scheduled tasks yet",
    activeGroup: "Active",
    groupEmpty: "None",
    backToChat: "Back to chat",
    createTask: "Create scheduled task",
    refreshAriaLabel: "Refresh scheduled tasks",
    selectOrCreate: "Select or create a task",
    needSavedChat: "Requires a saved chat",
    titlePlaceholder: "Scheduled task title",
    promptPlaceholder: "Add a prompt, e.g.: search for crashes in $sentry",
    detailsSection: "Details",
    environmentLabel: "Environment",
    environmentInfo: "Background tasks run in the current worktree",
    workspaceValue: "Worktree",
    projectLabel: "Project",
    currentProjectFallback: "Current project",
    boundChatLabel: "Linked chat",
    selectChatPlaceholder: "Select a chat",
    triggerLabel: "Trigger",
    triggerIntervalOption: "By interval",
    repeatCountLabel: "Repeat every",
    everyLabel: "Every",
    triggerAccountLabel: "Trigger account",
    anyConnectedMailbox: "Any connected mailbox",
    keywordsLabel: "Keywords",
    keywordsPlaceholder: "paper request, literature request",
    modelFieldLabel: "Model",
    statusLabel: "Status",
    statusGroupAriaLabel: "Task status",
    runPanelTriggerLabel: "Trigger",
    nextRunLabel: "Next run",
    lastRunLabel: "Last run",
    lastErrorLabel: "Last error",
    noErrorValue: "None",
    saveButton: "Save",
    viewChatButton: "View chat",
    deleteButton: "Delete",
    deleteConfirm: (title) => `Delete scheduled task "${title}"?`,
  },
};
