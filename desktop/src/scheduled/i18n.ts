import type { Language } from "../store";
import type {
  ScheduleKind,
  ScheduleMissedPolicy,
  ScheduledTaskInput,
  ScheduleTargetMode,
  WorkTaskVerdict,
} from "../types";

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
  scheduleKind?: ScheduleKind;
  cron?: string;
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
  mailPluginOff: string;
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
  ended: string;
  statusEnded: string;
  waitingForPrevious: string;
  ruleKindLabel: string;
  ruleKinds: Record<ScheduleKind, string>;
  timeZoneLabel: string;
  timeZoneInfo: string;
  timeZonePlaceholder: string;
  timeZoneLocal: (zone: string) => string;
  onceAtLabel: string;
  startAtLabel: string;
  startAtOptional: string;
  cronLabel: string;
  cronPlaceholder: string;
  cronHint: string;
  rruleLabel: string;
  rrulePlaceholder: string;
  rruleHint: string;
  rruleStartLabel: string;
  upcomingLabel: string;
  upcomingEmpty: string;
  upcomingInZone: (zone: string) => string;
  previewUnavailable: string;
  onceSummary: (time: string) => string;
  cronSummary: (expression: string) => string;
  rruleSummary: (rule: string) => string;
  missedPolicyLabel: string;
  missedPolicyInfo: string;
  missedPolicies: Record<ScheduleMissedPolicy, string>;
  targetModeLabel: string;
  targetModeInfo: string;
  targetModes: Record<ScheduleTargetMode, string>;
  targetNewOnceNote: (project: string) => string;
  targetNewNote: (project: string) => string;
  reviewerNote: string;
  runNowButton: string;
  runNowDone: string;
  historySection: string;
  historyNote: string;
  historyEmpty: string;
  historyLoading: string;
  historyPruned: string;
  historyDeliveryLabel: string;
  historyOutcomeLabel: string;
  historyCoalesced: (count: number) => string;
  historyRecovered: string;
  historyOpenSession: string;
  triggers: Record<string, string>;
  deliveryStatus: Record<string, string>;
  outcomeStatus: Record<string, string>;
  verdicts: Record<WorkTaskVerdict, string>;
  reviewExhausted: string;
  noOutcome: string;
  scheduleErrorLabel: string;
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
        triggerKind: "schedule",
        intervalValue: 30,
        intervalUnit: "minutes",
      },
      {
        id: "weekday-morning-digest",
        label: "工作日早 9 点·文献速递",
        category: "定时巡检",
        description: "工作日 09:00（按所选时区）检索新文献并汇总，结果经独立审查后在看板验收。",
        title: "工作日文献速递",
        prompt:
          "检索本项目研究方向最近 24 小时内的新论文（arXiv / Semantic Scholar），挑出最相关的 5 篇，写一段中文速递：每篇一句话说明贡献和与本项目的关系，附链接。没有新论文就明确说明，不要编造。",
        triggerKind: "schedule",
        scheduleKind: "cron",
        cron: "0 9 * * 1-5",
        intervalValue: DEFAULT_INTERVAL,
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
    mailPluginOff: "官方插件“邮箱”已关闭，新邮件不会触发这个任务。到“插件”页面打开后恢复。",
    intervalTrigger: "时间规则",
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
    promptHint: "任务被触发时，此提示词会作为工作任务排队执行，并经过独立审查。",
    detailsSection: "任务属性与配置",
    triggerSection: "触发规则与调度",
    targetContextSection: "执行环境与模型",
    metricsSection: "运行状况与指标",
    environmentLabel: "运行环境",
    environmentInfo: "每次运行都在独立的 git 工作树中执行，验收后才合并",
    workspaceValue: "工作树环境",
    projectLabel: "所属项目",
    currentProjectFallback: "当前项目",
    boundChatLabel: "绑定对话",
    selectChatPlaceholder: "选择绑定的对话",
    triggerLabel: "触发类型",
    triggerIntervalOption: "按时间规则",
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
    ended: "已结束",
    statusEnded: "已结束",
    waitingForPrevious: "等待上一次运行结束",
    ruleKindLabel: "规则类型",
    ruleKinds: { once: "一次", interval: "间隔", cron: "Cron", rrule: "RRULE" },
    timeZoneLabel: "时区",
    timeZoneInfo: "规则按此 IANA 时区的墙上时间解释；夏令时切换时自动换算。",
    timeZonePlaceholder: "例如 Asia/Shanghai",
    timeZoneLocal: (zone) => `本机（${zone}）`,
    onceAtLabel: "执行时间",
    startAtLabel: "首次执行",
    startAtOptional: "留空则从现在起一个间隔后开始",
    cronLabel: "Cron 表达式",
    cronPlaceholder: "0 9 * * 1-5",
    cronHint: "五段：分 时 日 月 周（Vixie 语义）。例：0 9 * * 1-5 = 工作日 09:00。",
    rruleLabel: "RRULE",
    rrulePlaceholder: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0",
    rruleHint: "RFC 5545 规则，最细到 HOURLY；也可粘贴带 DTSTART;TZID= 的完整两行。",
    rruleStartLabel: "起始（DTSTART）",
    upcomingLabel: "接下来",
    upcomingEmpty: "此规则没有未来的执行时间",
    upcomingInZone: (zone) => `按 ${zone} 显示`,
    previewUnavailable: "浏览器预览中无法计算执行时间",
    onceSummary: (time) => `一次 · ${time}`,
    cronSummary: (expression) => `Cron ${expression}`,
    rruleSummary: (rule) => `RRULE ${rule}`,
    missedPolicyLabel: "错过的执行",
    missedPolicyInfo: "SomniQ 未运行或上一次运行未结束时错过的多次执行，会合并为一次。",
    missedPolicies: {
      run_latest: "合并为最近一次并补跑",
      skip: "跳过（晚于 2 分钟即不补跑）",
    },
    targetModeLabel: "投递目标",
    targetModeInfo: "每次运行都作为工作任务排队，在隔离工作树中执行并经过独立审查；这里只决定对话记录写到哪里。",
    targetModes: {
      session: "固定对话",
      new_once: "首次新建，之后复用",
      new: "每次新建对话",
    },
    targetNewOnceNote: (project) => `首次运行时在「${project}」中新建一个对话，之后的运行都继续这个对话。`,
    targetNewNote: (project) => `每次运行都在「${project}」中新建一个对话。`,
    reviewerNote: "执行器 → 独立审查 → 修订，结果在工作任务看板验收。",
    runNowButton: "立即运行",
    runNowDone: "已加入工作任务队列",
    historySection: "投递记录",
    historyNote: "“投递”只证明这次运行已排入工作任务队列；“结果”来自对应工作任务卡片的状态与独立审查结论。",
    historyEmpty: "还没有投递记录",
    historyLoading: "加载投递记录...",
    historyPruned: "更早的记录已按保留上限清理",
    historyDeliveryLabel: "投递",
    historyOutcomeLabel: "结果",
    historyCoalesced: (count) => `合并了 ${count} 次错过的执行`,
    historyRecovered: "重启后补记（未重复排队）",
    historyOpenSession: "打开对话",
    triggers: { schedule: "定时", manual: "手动", mail: "邮件" },
    deliveryStatus: {
      queued: "已入队",
      missed: "已错过",
      skipped: "已跳过",
      failed: "投递失败",
    },
    outcomeStatus: {
      todo: "待开始",
      queued: "排队中",
      preparing: "准备中",
      running: "运行中",
      pausing: "暂停中",
      paused: "已暂停",
      awaiting_input: "等待回答",
      reviewing: "独立审查中",
      revising: "按审查修订中",
      review: "待验收",
      merging: "合并中",
      interrupted: "已中断",
      done: "已完成",
      failed: "失败",
      canceled: "已取消",
      missing: "卡片已删除",
    },
    verdicts: {
      pass: "审查通过",
      revise: "需修改",
      needs_user: "需要你决定",
      unavailable: "未经审查",
    },
    reviewExhausted: "审查轮次已用尽",
    noOutcome: "未产生工作任务",
    scheduleErrorLabel: "规则无法解析",
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
        category: "Mail automation",
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
        category: "Scheduled checks",
        description: "Periodically scan the inbox for literature/paper request emails and reply with the PDF.",
        title: "Scheduled poll · paper request auto-reply",
        prompt:
          "Check the inbox of my connected mail account(s) for literature/paper request emails. Call the mail_literature_catch_up tool to search, download the PDF, and reply per the \"Settings > Mail automation\" configuration (source, auto-send, allowlist). When done, summarize in one sentence: which requests were identified, how many replies were sent/prepared, and whether any failed. If there is no connected mailbox or no matching email, state that clearly - do not fabricate a result.",
        triggerKind: "schedule",
        intervalValue: 30,
        intervalUnit: "minutes",
      },
      {
        id: "weekday-morning-digest",
        label: "Weekdays 09:00 · literature digest",
        category: "Scheduled checks",
        description: "Every weekday at 09:00 (in the chosen time zone), search for new papers and summarize them; the result goes through independent review before you accept it.",
        title: "Weekday literature digest",
        prompt:
          "Search arXiv / Semantic Scholar for papers from the last 24 hours in this project's research area, pick the 5 most relevant, and write a short digest: one sentence per paper on its contribution and how it relates to this project, with links. If there are none, say so plainly - do not fabricate.",
        triggerKind: "schedule",
        scheduleKind: "cron",
        cron: "0 9 * * 1-5",
        intervalValue: DEFAULT_INTERVAL,
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
    mailTrigger: "Mail trigger",
    mailPluginOff: "The official Mail plugin is off, so new mail will not start this task. Turn it on in Plugins to resume.",
    intervalTrigger: "Time rule",
    sessionFallbackTitle: (id) => `Chat ${id}`,
    unboundSession: "No linked chat",
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
    heading: "Scheduled tasks",
    subheading: "Recurring background tasks, event reminders and mail workflows",
    searchPlaceholder: "Search tasks, prompts, models or chats…",
    loading: "Loading tasks…",
    emptyTasksTitle: "No scheduled tasks yet",
    emptyTasksSubtitle: "Click \"Create scheduled task\" above or pick a template on the left to get started",
    activeGroup: "Active",
    pausedGroup: "Paused",
    groupEmpty: "No tasks",
    backToChat: "Back to chat",
    createTask: "Create scheduled task",
    refreshAriaLabel: "Refresh scheduled tasks",
    selectOrCreate: "Select a task from the list or create a new one above",
    needSavedChat: "Requires at least one saved chat",
    titlePlaceholder: "Task name (e.g. Scheduled literature digest)",
    promptPlaceholder: "Prompt or automation instructions to run when triggered, e.g. find crashes in $sentry and summarize them…",
    promptHint: "When triggered, this prompt is queued as a work task and goes through independent review.",
    detailsSection: "Task properties and settings",
    triggerSection: "Trigger and schedule",
    targetContextSection: "Execution environment and model",
    metricsSection: "Health and metrics",
    environmentLabel: "Environment",
    environmentInfo: "Each run works in its own git worktree and is merged only when you accept it",
    workspaceValue: "Worktree",
    projectLabel: "Project",
    currentProjectFallback: "Current project",
    boundChatLabel: "Linked chat",
    selectChatPlaceholder: "Select a chat",
    triggerLabel: "Trigger type",
    triggerIntervalOption: "On a time rule",
    repeatCountLabel: "Repeat cadence",
    everyLabel: "Every",
    triggerAccountLabel: "Trigger account",
    anyConnectedMailbox: "Any connected mailbox",
    keywordsLabel: "Match keywords",
    keywordsPlaceholder: "paper request, literature request",
    presetIntervalsLabel: "Quick intervals",
    presetKeywordsLabel: "Common keywords",
    modelFieldLabel: "Model",
    statusLabel: "Status",
    statusGroupAriaLabel: "Task status",
    runPanelTriggerLabel: "Trigger",
    nextRunLabel: "Next run",
    lastRunLabel: "Last run",
    lastErrorLabel: "Latest status",
    noErrorValue: "Healthy",
    saveButton: "Save",
    saveChangesButton: "Save changes",
    createTaskButton: "Create task",
    savingText: "Saving…",
    viewChatButton: "View transcript",
    deleteButton: "Delete task",
    deleteConfirm: (title) => `Delete the scheduled task "${title}"? This can't be undone.`,
    useTemplateButton: "Use template",
    statusActive: "Active",
    statusPaused: "Paused",
    statusHealthy: "Healthy",
    statusError: "Failed",
    jumpToSession: "Open chat",
    ended: "Ended",
    statusEnded: "Ended",
    waitingForPrevious: "Waiting for the previous run",
    ruleKindLabel: "Rule",
    ruleKinds: { once: "Once", interval: "Interval", cron: "Cron", rrule: "RRULE" },
    timeZoneLabel: "Time zone",
    timeZoneInfo: "The rule follows wall-clock time in this IANA time zone; daylight saving changes are handled automatically.",
    timeZonePlaceholder: "e.g. Asia/Shanghai",
    timeZoneLocal: (zone) => `This device (${zone})`,
    onceAtLabel: "Run at",
    startAtLabel: "First run",
    startAtOptional: "Leave empty to start one interval from now",
    cronLabel: "Cron expression",
    cronPlaceholder: "0 9 * * 1-5",
    cronHint: "Five fields: minute hour day month weekday (Vixie). 0 9 * * 1-5 = weekdays at 09:00.",
    rruleLabel: "RRULE",
    rrulePlaceholder: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0",
    rruleHint: "RFC 5545, HOURLY or coarser. A full DTSTART;TZID= + RRULE pair is accepted too.",
    rruleStartLabel: "Start (DTSTART)",
    upcomingLabel: "Next runs",
    upcomingEmpty: "This rule has no future occurrences",
    upcomingInZone: (zone) => `Shown in ${zone}`,
    previewUnavailable: "Run times can't be computed in the browser preview",
    onceSummary: (time) => `Once · ${time}`,
    cronSummary: (expression) => `Cron ${expression}`,
    rruleSummary: (rule) => `RRULE ${rule}`,
    missedPolicyLabel: "Missed runs",
    missedPolicyInfo: "Runs missed while SomniQ was closed, or while the previous run was still going, are folded into one.",
    missedPolicies: {
      run_latest: "Fold into the latest and run it",
      skip: "Skip (no catch-up after 2 minutes)",
    },
    targetModeLabel: "Deliver to",
    targetModeInfo: "Every run is queued as a work task: isolated worktree, independent review. This only decides which conversation holds the transcript.",
    targetModes: {
      session: "Fixed chat",
      new_once: "New once, then reuse",
      new: "New chat each run",
    },
    targetNewOnceNote: (project) => `The first run opens a new chat in "${project}"; later runs continue it.`,
    targetNewNote: (project) => `Every run opens a new chat in "${project}".`,
    reviewerNote: "Executor → independent Reviewer → revision; accept the result on the work-task board.",
    runNowButton: "Run now",
    runNowDone: "Queued as a work task",
    historySection: "Deliveries",
    historyNote: "A delivery only proves the run was queued as a work task; the result comes from that task's status and independent review.",
    historyEmpty: "No deliveries yet",
    historyLoading: "Loading deliveries…",
    historyPruned: "Older records were pruned by retention",
    historyDeliveryLabel: "Delivery",
    historyOutcomeLabel: "Result",
    historyCoalesced: (count) => `${count} missed ${count === 1 ? "run" : "runs"} folded in`,
    historyRecovered: "Recorded after a restart (not queued twice)",
    historyOpenSession: "Open chat",
    triggers: { schedule: "Scheduled", manual: "Manual", mail: "Mail" },
    deliveryStatus: {
      queued: "Queued",
      missed: "Missed",
      skipped: "Skipped",
      failed: "Not delivered",
    },
    outcomeStatus: {
      todo: "To do",
      queued: "Queued",
      preparing: "Preparing",
      running: "Running",
      pausing: "Pausing",
      paused: "Paused",
      awaiting_input: "Awaiting answer",
      reviewing: "In independent review",
      revising: "Revising",
      review: "Ready to accept",
      merging: "Merging",
      interrupted: "Interrupted",
      done: "Done",
      failed: "Failed",
      canceled: "Canceled",
      missing: "Card deleted",
    },
    verdicts: {
      pass: "Review passed",
      revise: "Needs changes",
      needs_user: "Needs your decision",
      unavailable: "Not reviewed",
    },
    reviewExhausted: "Review rounds exhausted",
    noOutcome: "No work task",
    scheduleErrorLabel: "Rule can't be parsed",
  },
  es: {
    unitLabels: {
      minutes: "minutos",
      hours: "horas",
      days: "días",
    },
    taskTemplates: [
      {
        id: "literature-mail-on-arrival",
        label: "Disparador de correo nuevo · respuesta automática a solicitudes de artículos",
        category: "Automatización de correo",
        description:
          "Cuando llega un correo nuevo con palabras clave como \"solicitud de literatura/solicitud de artículo\", busca el PDF y responde con él automáticamente.",
        title: "Correo nuevo · respuesta automática a solicitudes de artículos",
        prompt:
          "Un correo nuevo ha disparado esta tarea (los detalles del correo se adjuntan abajo). Primero usa mail_read para leer el correo y confirmar que es una solicitud de literatura/artículo; después llama a mail_literature_catch_up (opcionalmente limitado a esta cuenta) para buscar, descargar el PDF y responder según la configuración de \"Configuración > Automatización de correo\". Termina con un resumen de una frase del resultado; si no es un correo de solicitud, omítelo y no inventes un resultado.",
        triggerKind: "mail",
        intervalValue: DEFAULT_INTERVAL,
        intervalUnit: "minutes",
        mailKeywords: "文献求助, 论文求助, paper request, literature request, solicitud de artículo",
      },
      {
        id: "literature-mail-poll",
        label: "Sondeo programado · respuesta automática a solicitudes de artículos",
        category: "Sondeo programado",
        description: "Revisa periódicamente la bandeja de entrada en busca de solicitudes de literatura/artículos y responde con el PDF.",
        title: "Sondeo programado · respuesta automática a solicitudes de artículos",
        prompt:
          "Revisa la bandeja de entrada de mis cuentas de correo conectadas en busca de solicitudes de literatura/artículos. Llama a la herramienta mail_literature_catch_up para buscar, descargar el PDF y responder según la configuración de \"Configuración > Automatización de correo\" (fuente, envío automático, lista de permitidos). Al terminar, resume en una frase qué solicitudes se identificaron, cuántas respuestas se enviaron o prepararon y si alguna falló. Si no hay ningún buzón conectado o ningún correo que coincida, dilo claramente y no inventes un resultado.",
        triggerKind: "schedule",
        intervalValue: 30,
        intervalUnit: "minutes",
      },
      {
        id: "weekday-morning-digest",
        label: "Días laborables 09:00 · resumen de literatura",
        category: "Sondeo programado",
        description: "Cada día laborable a las 09:00 (en la zona elegida), busca artículos nuevos y los resume; el resultado pasa por una revisión independiente antes de que lo aceptes.",
        title: "Resumen de literatura de días laborables",
        prompt:
          "Busca en arXiv / Semantic Scholar artículos de las últimas 24 horas en el área de investigación de este proyecto, elige los 5 más relevantes y escribe un resumen breve: una frase por artículo sobre su aportación y su relación con este proyecto, con enlaces. Si no hay ninguno, dilo claramente y no inventes nada.",
        triggerKind: "schedule",
        scheduleKind: "cron",
        cron: "0 9 * * 1-5",
        intervalValue: DEFAULT_INTERVAL,
        intervalUnit: "minutes",
      },
    ],
    noValue: "Ninguno",
    paused: "En pausa",
    lastRunFailed: "La última ejecución falló",
    lastRunAt: (time) => `Última ejecución ${time}`,
    waitingForMail: "Esperando correo nuevo",
    nextRunAt: (time) => `Próxima ejecución ${time}`,
    waitingFirstRun: "Esperando la primera ejecución",
    mailTrigger: "Disparador de correo",
    mailPluginOff: "El plugin oficial de Correo está desactivado, así que el correo nuevo no iniciará esta tarea. Actívalo en Plugins para reanudarla.",
    intervalTrigger: "Regla de tiempo",
    sessionFallbackTitle: (id) => `Chat ${id}`,
    unboundSession: "Chat sin vincular",
    followCurrentModel: "Seguir el modelo actual",
    everyInterval: (value, unitLabel) => `Cada ${value} ${unitLabel}`,
    untitledTask: "Tarea sin título",
    start: "Iniciar",
    pause: "Pausar",
    viewSessionTitle: "Ver la conversación en la que se ejecuta esta tarea",
    onNewMail: "Cuando llegue correo nuevo",
    currentModelOption: "Modelo actual",
    previewModelLabel: "Vista previa",
    previewModelDescription: "Vista previa del navegador",
    tabsAriaLabel: "Vista de tareas programadas",
    tabTasks: "Tareas",
    tabTemplates: "Plantillas",
    filterAll: "Todas",
    filterActive: "Activas",
    filterPaused: "En pausa",
    filterEmpty: "No hay tareas que coincidan",
    heading: "Tareas programadas",
    subheading: "Tareas recurrentes automatizadas, monitorización y flujos de correo",
    searchPlaceholder: "Buscar tareas, prompts, modelos o chats…",
    loading: "Cargando tareas…",
    emptyTasksTitle: "Aún no hay tareas programadas",
    emptyTasksSubtitle: "Haz clic en \"Crear tarea programada\" arriba o elige una plantilla a la izquierda para empezar",
    activeGroup: "Activas",
    pausedGroup: "En pausa",
    groupEmpty: "Sin tareas",
    backToChat: "Volver al chat",
    createTask: "Crear tarea programada",
    refreshAriaLabel: "Actualizar tareas programadas",
    selectOrCreate: "Selecciona una tarea de la lista o crea una nueva arriba",
    needSavedChat: "Requiere al menos una sesión de chat guardada",
    titlePlaceholder: "Escribe el título de la tarea (p. ej., Resumen diario de literatura)",
    promptPlaceholder: "Escribe el prompt o las instrucciones automáticas al dispararse…",
    promptHint: "Al dispararse, este prompt se pone en cola como tarea de trabajo y pasa por una revisión independiente.",
    detailsSection: "Configuración y parámetros de la tarea",
    triggerSection: "Disparador y programación",
    targetContextSection: "Contexto de ejecución y modelo",
    metricsSection: "Métricas y estado",
    environmentLabel: "Entorno",
    environmentInfo: "Cada ejecución trabaja en su propio worktree de git y solo se fusiona cuando la aceptas",
    workspaceValue: "Worktree",
    projectLabel: "Proyecto",
    currentProjectFallback: "Proyecto actual",
    boundChatLabel: "Chat vinculado",
    selectChatPlaceholder: "Selecciona un chat",
    triggerLabel: "Tipo de disparador",
    triggerIntervalOption: "Según una regla de tiempo",
    repeatCountLabel: "Frecuencia de repetición",
    everyLabel: "Cada",
    triggerAccountLabel: "Cuenta que dispara",
    anyConnectedMailbox: "Cualquier buzón conectado",
    keywordsLabel: "Palabras clave",
    keywordsPlaceholder: "solicitud de artículo, solicitud de literatura",
    presetIntervalsLabel: "Intervalos rápidos",
    presetKeywordsLabel: "Palabras clave habituales",
    modelFieldLabel: "Modelo",
    statusLabel: "Estado",
    statusGroupAriaLabel: "Estado de la tarea",
    runPanelTriggerLabel: "Disparador",
    nextRunLabel: "Próxima ejecución",
    lastRunLabel: "Última ejecución",
    lastErrorLabel: "Estado de salud",
    noErrorValue: "Correcto",
    saveButton: "Guardar",
    saveChangesButton: "Guardar cambios",
    createTaskButton: "Crear tarea",
    savingText: "Guardando…",
    viewChatButton: "Ver conversación",
    deleteButton: "Eliminar tarea",
    deleteConfirm: (title) => `¿Seguro que quieres eliminar la tarea "${title}"? Esta acción no se puede deshacer.`,
    useTemplateButton: "Usar plantilla",
    statusActive: "Activa",
    statusPaused: "En pausa",
    statusHealthy: "Correcto",
    statusError: "Fallida",
    jumpToSession: "Abrir chat",
    ended: "Finalizada",
    statusEnded: "Finalizada",
    waitingForPrevious: "Esperando la ejecución anterior",
    ruleKindLabel: "Regla",
    ruleKinds: { once: "Una vez", interval: "Intervalo", cron: "Cron", rrule: "RRULE" },
    timeZoneLabel: "Zona horaria",
    timeZoneInfo: "La regla se interpreta según la hora local de esta zona IANA; se tienen en cuenta los cambios de horario de verano.",
    timeZonePlaceholder: "p. ej., Asia/Shanghai",
    timeZoneLocal: (zone) => `Este dispositivo (${zone})`,
    onceAtLabel: "Ejecutar a las",
    startAtLabel: "Primera ejecución",
    startAtOptional: "Vacío = dentro de un intervalo",
    cronLabel: "Expresión cron",
    cronPlaceholder: "0 9 * * 1-5",
    cronHint: "Cinco campos: minuto hora día mes día_de_la_semana (Vixie). 0 9 * * 1-5 = días laborables a las 09:00.",
    rruleLabel: "RRULE",
    rrulePlaceholder: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0",
    rruleHint: "RFC 5545, HOURLY o menos frecuente. También se acepta un par completo DTSTART;TZID= + RRULE.",
    rruleStartLabel: "Inicio (DTSTART)",
    upcomingLabel: "Próximas ejecuciones",
    upcomingEmpty: "Esta regla no tiene ejecuciones futuras",
    upcomingInZone: (zone) => `Mostrado en ${zone}`,
    previewUnavailable: "Las ejecuciones no se pueden calcular en la vista previa del navegador",
    onceSummary: (time) => `Una vez · ${time}`,
    cronSummary: (expression) => `Cron ${expression}`,
    rruleSummary: (rule) => `RRULE ${rule}`,
    missedPolicyLabel: "Ejecuciones perdidas",
    missedPolicyInfo: "Las ejecuciones perdidas mientras SomniQ estaba cerrado, o mientras la anterior seguía en curso, se agrupan en una sola.",
    missedPolicies: {
      run_latest: "Agrupar en la más reciente y ejecutarla",
      skip: "Omitir (sin recuperación pasados 2 minutos)",
    },
    targetModeLabel: "Entregar en",
    targetModeInfo: "Cada ejecución se pone en cola como tarea de trabajo: worktree aislado y revisión independiente. Esto solo decide qué conversación guarda el registro.",
    targetModes: {
      session: "Chat fijo",
      new_once: "Nuevo una vez y después reutilizar",
      new: "Chat nuevo en cada ejecución",
    },
    targetNewOnceNote: (project) => `La primera ejecución abre un chat nuevo en "${project}"; las siguientes lo continúan.`,
    targetNewNote: (project) => `Cada ejecución abre un chat nuevo en "${project}".`,
    reviewerNote: "Executor → Reviewer independiente → revisión; acepta el resultado en el tablero de tareas de trabajo.",
    runNowButton: "Ejecutar ahora",
    runNowDone: "En cola como tarea de trabajo",
    historySection: "Entregas",
    historyNote: "Una entrega solo demuestra que la ejecución se puso en cola como tarea de trabajo; el resultado depende del estado de esa tarea y de la revisión independiente.",
    historyEmpty: "Aún no hay entregas",
    historyLoading: "Cargando entregas…",
    historyPruned: "Los registros antiguos se eliminaron por la política de retención",
    historyDeliveryLabel: "Entrega",
    historyOutcomeLabel: "Resultado",
    historyCoalesced: (count) => `${count} ${count === 1 ? "ejecución perdida agrupada" : "ejecuciones perdidas agrupadas"}`,
    historyRecovered: "Registrada tras un reinicio (no se puso en cola dos veces)",
    historyOpenSession: "Abrir chat",
    triggers: { schedule: "Programada", manual: "Manual", mail: "Correo" },
    deliveryStatus: {
      queued: "En cola",
      missed: "Perdida",
      skipped: "Omitida",
      failed: "No entregada",
    },
    outcomeStatus: {
      todo: "Pendiente",
      queued: "En cola",
      preparing: "Preparando",
      running: "En ejecución",
      pausing: "Pausando",
      paused: "En pausa",
      awaiting_input: "Esperando respuesta",
      reviewing: "Revisión independiente",
      revising: "Revisando",
      review: "Lista para aceptar",
      merging: "Fusionando",
      interrupted: "Interrumpida",
      done: "Hecha",
      failed: "Fallida",
      canceled: "Cancelada",
      missing: "Tarjeta eliminada",
    },
    verdicts: {
      pass: "Revisión superada",
      revise: "Requiere cambios",
      needs_user: "Requiere tu decisión",
      unavailable: "Sin revisar",
    },
    reviewExhausted: "Rondas de revisión agotadas",
    noOutcome: "Sin tarea de trabajo",
    scheduleErrorLabel: "No se puede leer la regla",
  },
};
