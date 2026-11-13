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
        triggerKind: "schedule",
        intervalValue: 30,
        intervalUnit: "minutes",
      },
      {
        id: "weekday-morning-digest",
        label: "Weekdays 09:00 · literature digest",
        category: "Scheduled Poll",
        description: "Every weekday at 09:00 (in the chosen zone), search for new papers and summarize them; the result goes through independent review before you accept it.",
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
    mailTrigger: "Mail Trigger",
    intervalTrigger: "Time rule",
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
    promptHint: "When triggered, this prompt is queued as a work task and goes through independent review.",
    detailsSection: "Task Settings & Parameters",
    triggerSection: "Trigger & Scheduling",
    targetContextSection: "Execution Context & Model",
    metricsSection: "Metrics & Health",
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
    ended: "Ended",
    statusEnded: "Ended",
    waitingForPrevious: "Waiting for the previous run",
    ruleKindLabel: "Rule",
    ruleKinds: { once: "Once", interval: "Interval", cron: "Cron", rrule: "RRULE" },
    timeZoneLabel: "Time zone",
    timeZoneInfo: "The rule is read on this IANA zone's wall clock; DST changes are handled.",
    timeZonePlaceholder: "e.g. Asia/Shanghai",
    timeZoneLocal: (zone) => `This device (${zone})`,
    onceAtLabel: "Run at",
    startAtLabel: "First run",
    startAtOptional: "Empty = one interval from now",
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
    previewUnavailable: "Occurrences cannot be computed in the browser preview",
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
    historyLoading: "Loading deliveries...",
    historyPruned: "Older records were pruned by retention",
    historyDeliveryLabel: "Delivery",
    historyOutcomeLabel: "Result",
    historyCoalesced: (count) => `${count} missed run(s) folded in`,
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
      reviewing: "Independent review",
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
    scheduleErrorLabel: "Rule cannot be read",
  },
};
