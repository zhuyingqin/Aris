import type { Language } from "../store";
import type { ScheduledTaskInput } from "../types";

export type IntervalUnit = ScheduledTaskInput["intervalUnit"];
export type TriggerKind = NonNullable<ScheduledTaskInput["triggerKind"]>;

export interface TaskTemplate {
  id: string;
  label: string;
  category?: string;
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
  filterAll: string;
  filterActive: string;
  filterPaused: string;
  filterEmpty: string;
  heading: string;
  subheading: string;
  searchPlaceholder: string;
  loading: string;
  emptyTasksTitle: string;
  emptyTasksSubtitle: string;
  activeGroup: string;
  pausedGroup: string;
  groupEmpty: string;
  backToChat: string;
  createTask: string;
  refreshAriaLabel: string;
  selectOrCreate: string;
  needSavedChat: string;
  titlePlaceholder: string;
  promptPlaceholder: string;
  promptHint: string;
  detailsSection: string;
  triggerSection: string;
  targetContextSection: string;
  metricsSection: string;
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
  presetIntervalsLabel: string;
  presetKeywordsLabel: string;
  modelFieldLabel: string;
  statusLabel: string;
  statusGroupAriaLabel: string;
  runPanelTriggerLabel: string;
  nextRunLabel: string;
  lastRunLabel: string;
  lastErrorLabel: string;
  noErrorValue: string;
  saveButton: string;
  saveChangesButton: string;
  createTaskButton: string;
  savingText: string;
  viewChatButton: string;
  deleteButton: string;
  deleteConfirm: (title: string) => string;
  useTemplateButton: string;
  statusActive: string;
  statusPaused: string;
  statusHealthy: string;
  statusError: string;
  jumpToSession: string;
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
        category: "邮件自动化",
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
        category: "定时巡检",
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
    mailTrigger: "邮件触发",
    intervalTrigger: "定时循环",
    sessionFallbackTitle: (id) => `对话 ${id}`,
    unboundSession: "未绑定对话",
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
    tabTasks: "任务列表",
    tabTemplates: "预设模板",
    filterAll: "全部",
    filterActive: "运行中",
    filterPaused: "已暂停",
    filterEmpty: "无匹配任务",
    heading: "已安排任务",
    subheading: "自动化后台周期任务、事件提醒与邮件工作流",
    searchPlaceholder: "搜索任务标题、指令、模型或对话...",
    loading: "加载任务中...",
    emptyTasksTitle: "暂无定时任务",
    emptyTasksSubtitle: "点击上方「创建计划任务」或选择左侧预设模板开始",
    activeGroup: "运行中",
    pausedGroup: "已暂停",
    groupEmpty: "暂无任务",
    backToChat: "返回对话",
    createTask: "创建计划任务",
    refreshAriaLabel: "刷新定时任务",
    selectOrCreate: "请从左侧选择任务，或点击上方创建新任务",
    needSavedChat: "需要至少存在一个已保存的对话",
    titlePlaceholder: "输入任务名称（例如：定时文献速递）",
    promptPlaceholder: "输入触发后执行的提示词或自动化指令，例如：在 $sentry 中查找崩溃并汇总...",
    promptHint: "任务被触发时，会将此提示词自动发送到绑定的对话中执行。",
    detailsSection: "任务属性与配置",
    triggerSection: "触发规则与调度",
    targetContextSection: "执行环境与模型",
    metricsSection: "运行状况与指标",
    environmentLabel: "运行环境",
    environmentInfo: "后台任务会在当前工作树执行",
    workspaceValue: "工作树环境",
    projectLabel: "所属项目",
    currentProjectFallback: "当前项目",
    boundChatLabel: "绑定对话",
    selectChatPlaceholder: "选择绑定的对话",
    triggerLabel: "触发类型",
    triggerIntervalOption: "按时间周期间隔",
    repeatCountLabel: "执行周期",
    everyLabel: "每隔",
    triggerAccountLabel: "触发邮箱",
    anyConnectedMailbox: "任意已连接邮箱账户",
    keywordsLabel: "匹配关键词",
    keywordsPlaceholder: "文献求助, 论文求助, paper request",
    presetIntervalsLabel: "快捷间隔",
    presetKeywordsLabel: "常用关键词",
    modelFieldLabel: "执行模型",
    statusLabel: "任务状态",
    statusGroupAriaLabel: "任务状态",
    runPanelTriggerLabel: "触发机制",
    nextRunLabel: "下次执行",
    lastRunLabel: "上次执行",
    lastErrorLabel: "最近状态",
    noErrorValue: "正常运行",
    saveButton: "保存",
    saveChangesButton: "保存修改",
    createTaskButton: "创建任务",
    savingText: "保存中...",
    viewChatButton: "查看对话记录",
    deleteButton: "删除任务",
    deleteConfirm: (title) => `确定要删除定时任务「${title}」吗？此操作无法撤销。`,
    useTemplateButton: "使用此模板",
    statusActive: "运行中",
    statusPaused: "已暂停",
    statusHealthy: "正常运行",
    statusError: "执行异常",
    jumpToSession: "跳转对话",
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
        label: "New mail trigger · paper request auto-reply",
        category: "Mail Automation",
        description:
          "When a new email arrives containing keywords like \"literature request/paper request\", automatically search for and reply with the PDF.",
        title: "New mail · paper request auto-reply",
        prompt:
          "A new email triggered this task (the email details are appended below). First use mail_read to read the email and confirm it is a literature/paper request, then call mail_literature_catch_up (optionally scoped to this account) to search, download the PDF, and reply per the \"Settings > Mail automation\" configuration. Finish with a one-sentence summary of the outcome; if it is not a request email, skip it - do not fabricate a result.",
        triggerKind: "mail",
        intervalValue: DEFAULT_INTERVAL,
        intervalUnit: "minutes",
        mailKeywords: "文献求助, 论文求助, paper request, literature request",
      },
      {
        id: "literature-mail-poll",
        label: "Scheduled poll · paper request auto-reply",
        category: "Scheduled Poll",
        description: "Periodically scan the inbox for literature/paper request emails and reply with the PDF.",
        title: "Scheduled poll · paper request auto-reply",
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
    mailTrigger: "Mail Trigger",
    intervalTrigger: "Interval Loop",
    sessionFallbackTitle: (id) => `Chat ${id}`,
    unboundSession: "Unbound Chat",
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
    filterAll: "All",
    filterActive: "Active",
    filterPaused: "Paused",
    filterEmpty: "No matching tasks",
    heading: "Scheduled Tasks",
    subheading: "Automated recurring tasks, monitoring, and email workflows",
    searchPlaceholder: "Search tasks, prompts, models or chats...",
    loading: "Loading tasks...",
    emptyTasksTitle: "No scheduled tasks yet",
    emptyTasksSubtitle: "Click 'Create task' above or pick a template from the left to start",
    activeGroup: "Active",
    pausedGroup: "Paused",
    groupEmpty: "No tasks",
    backToChat: "Back to chat",
    createTask: "Create scheduled task",
    refreshAriaLabel: "Refresh scheduled tasks",
    selectOrCreate: "Select a task from the list or create a new one above",
    needSavedChat: "Requires at least one saved chat session",
    titlePlaceholder: "Enter task title (e.g. Daily Literature Digest)",
    promptPlaceholder: "Enter prompt or automated instructions when triggered...",
    promptHint: "When triggered, this prompt is automatically executed in the bound chat session.",
    detailsSection: "Task Settings & Parameters",
    triggerSection: "Trigger & Scheduling",
    targetContextSection: "Execution Context & Model",
    metricsSection: "Metrics & Health",
    environmentLabel: "Environment",
    environmentInfo: "Background tasks run in the current worktree",
    workspaceValue: "Worktree",
    projectLabel: "Project",
    currentProjectFallback: "Current project",
    boundChatLabel: "Linked chat",
    selectChatPlaceholder: "Select a chat",
    triggerLabel: "Trigger type",
    triggerIntervalOption: "By time interval",
    repeatCountLabel: "Repeat cadence",
    everyLabel: "Every",
    triggerAccountLabel: "Trigger account",
    anyConnectedMailbox: "Any connected mailbox",
    keywordsLabel: "Match keywords",
    keywordsPlaceholder: "paper request, literature request",
    presetIntervalsLabel: "Quick Intervals",
    presetKeywordsLabel: "Popular Keywords",
    modelFieldLabel: "Model",
    statusLabel: "Status",
    statusGroupAriaLabel: "Task status",
    runPanelTriggerLabel: "Trigger",
    nextRunLabel: "Next run",
    lastRunLabel: "Last run",
    lastErrorLabel: "Health status",
    noErrorValue: "Healthy",
    saveButton: "Save",
    saveChangesButton: "Save Changes",
    createTaskButton: "Create Task",
    savingText: "Saving...",
    viewChatButton: "View Transcript",
    deleteButton: "Delete Task",
    deleteConfirm: (title) => `Are you sure you want to delete task "${title}"? This cannot be undone.`,
    useTemplateButton: "Use Template",
    statusActive: "Active",
    statusPaused: "Paused",
    statusHealthy: "Healthy",
    statusError: "Failed",
    jumpToSession: "Open Chat",
  },
};
