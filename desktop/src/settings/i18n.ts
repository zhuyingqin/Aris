import type { Language } from "../store";
import type { RemoteScope } from "../types";

// Shared across SettingsProvidersCopy and SettingsMailCopy, which both need
// their own `testTesting` field (different domains, same label) — kept as
// one source of truth so the two copies can't drift apart.
const TEST_TESTING_LABEL: Record<Language, string> = { cn: "测试中...", en: "Testing..." };

export interface SettingsGeneralCopy {
  settingsCategories: string;
  loading: string;
  statusModelService: string;
  statusVersion: string;
  languageTitle: string;
  languageSub: string;
  saveSaving: string;
  saveSaved: string;
  savePrefs: string;
  appearanceTitle: string;
  appearanceSub: string;
  themeLabel: string;
  light: string;
  dark: string;
  localBehaviorTitle: string;
  localBehaviorSub: string;
  confirmBeforeWrite: string;
  autoWrite: string;
  saveBehavior: string;
  systemPromptTitle: string;
  systemPromptSub: string;
  userPromptTitle: string;
  userPromptSub: string;
  promptView: string;
  promptHide: string;
  promptModel: string;
  promptUnknown: string;
  promptSections: (count: number) => string;
  promptChars: (count: string) => string;
  promptFullTools: string;
  promptLimitedTools: string;
  promptLoading: string;
  promptRefresh: string;
  systemPromptLoading: string;
  userPromptEmpty: string;
  userPromptSource: string;
  userPromptNoSource: string;
  userPromptNotCaptured: string;
  userPromptBlocks: (count: number) => string;
  userPromptImages: (count: number) => string;
  userPromptLoading: string;
  creditUnit: string;
  accountUsedQuota: string;
  accountBalance: string;
  accountTotalQuota: string;
  accountUsageRatio: string;
  subscriptionUsed: string;
  subscriptionBalance: string;
  subscriptionUsageRatio: string;
  callDetails: string;
  usageRange: (start: number, end: number, total: number) => string;
  usageNoRecords: string;
  usageLoading: string;
  usageStatusSuccess: string;
  usageStatusFailed: string;
  usageTypeConsume: string;
  usageHeaders: {
    time: string;
    model: string;
    token: string;
    tokens: string;
    quota: string;
    request: string;
  };
  usagePageSummary: (pageSize: number, page: number, pageCount: number) => string;
  usagePrev: string;
  usageNext: string;
  usageEmpty: string;
  authAccountTitle: string;
  authAccountSub: string;
  authRefresh: string;
  authRefreshing: string;
  authLogout: string;
  authSignedIn: string;
  authSignedOut: string;
  authSignedOutSub: string;
  authSubscriptionLabel: string;
  authGroupTag: (group: string) => string;
  authRefreshFailed: (error: string) => string;
  aboutUpdateTitle: string;
  aboutUpdateSub: string;
  aboutCheck: string;
  aboutChecking: string;
  aboutDownloadInstall: string;
  aboutRestart: string;
  aboutUpdateAvailable: (version: string) => string;
  aboutUpdateReady: (version: string) => string;
  aboutInstalling: string;
  aboutConnected: string;
  aboutCurrentVersion: (version: string) => string;
  aboutRemoteVersion: (version: string) => string;
  envTitle: string;
  envDetectingSub: string;
  envReadySummary: (ready: number, total: number, checkedAt?: string) => string;
  envSub: string;
  envRefresh: string;
  envDetecting: string;
  pythonEnvironmentTitle: string;
  pythonEnvironmentHint: string;
  pythonEnvironmentPlaceholder: string;
  pythonEnvironmentBrowseTitle: string;
  pythonEnvironmentBrowse: string;
  pythonEnvironmentUse: string;
  pythonEnvironmentSaving: string;
  pythonEnvironmentSaved: string;
  envEmpty: string;
  envStatusReady: string;
  envStatusWarning: string;
  envStatusMissing: string;
  envVersion: string;
  envPath: string;
  envUnknownVersion: string;
  envNotOnPath: string;
  envInstallInChat: string;
  envCategories: Record<"python" | "jupyter" | "matlab" | "latex", string>;
  envExecutableWarning: string;
  envAvailable: string;
  envMissingInstallable: (label: string) => string;
  envMissing: (label: string) => string;
  aboutLinksTitle: string;
  aboutLinksSub: string;
  aboutLinkRepo: string;
  aboutLinkReleases: string;
  aboutLinkLicense: string;
  updateMsgNewVersion: (version: string) => string;
  updateMsgUpToDate: string;
  updateMsgDownloading: string;
  updateMsgInstalled: string;
  updateMsgNoUpdateToInstall: string;
  updateDownloaded: (size: string) => string;
  groupLabel: string;
  groupHint: string;
  groupSave: string;
  groupSaving: string;
  groupLoading: string;
  groupEmpty: string;
  previewConfigPath: string;
  previewDisplayName: string;
  previewSubscriptionName: string;
  previewSubscriptionDescription: string;
  previewStandardGroupDescription: string;
  previewResearchGroupDescription: string;
  previewPremiumGroupDescription: string;
  previewUsageType: string;
  previewSystemPrompt: string;
  previewUserPrompt: string;
  previewUserPromptSurface: string;
}

export interface SettingsProvidersCopy {
  currentModelFallback: string;
  modelServiceTitle: string;
  modelServiceSub: string;
  modelSync: string;
  modelSyncing: string;
  executorModel: string;
  executorModelHint: string;
  transportResponses: string;
  transportChat: string;
  transportHint: string;
  reviewerModel: string;
  reviewerModelHint: string;
  reviewerModelOff: string;
  modelSyncAfterLogin: string;
  currentExecutor: (model: string) => string;
  currentReviewer: (model: string) => string;
  reviewerOff: string;
  modelSyncingStatus: string;
  modelSynced: (count: number) => string;
  modelSyncAfterLoginStatus: string;
  advancedExecutor: string;
  advancedReviewer: string;
  advancedProviderType: string;
  advancedSummaryTools: string;
  advancedSummaryToolsSub: string;
  advancedCollapse: string;
  advancedExpand: string;
  summaryProvider: string;
  summaryProviderHint: string;
  summaryFollowExecutor: string;
  summaryManual: string;
  summaryProtocol: string;
  summaryBaseUrl: string;
  summaryApiKey: string;
  summaryModel: string;
  summaryModelHint: string;
  retrievalCardModel: string;
  retrievalCardModelHint: string;
  retrievalCardFollowExecutor: string;
  testTesting: string;
  testConnectionConfig: string;
  saveConnectionConfig: string;
  saveConnectionSavedInfo: string;
  fieldModel: string;
  fieldBaseUrl: string;
  fieldApiKey: string;
  fieldConfigFile: string;
  fieldScopusKey: string;
  fieldOpenalexKey: string;
  fieldBraveSearchKey: string;
  fieldExaKey: string;
  fieldZhihuAccessSecret: string;
  /** Takes one of the `field*Key` labels above so the two can't drift apart. */
  clearProviderKeyConfirm: (secretLabel: string) => string;
  zhihuSearchHint: string;
  fieldWebProxyUrl: string;
  webProxyHint: string;
  webProxyPlaceholder: string;
  presetCustom: string;
  presetOfficial: string;
  presetHints: Record<string, string>;
  keySaved: (masked: string) => string;
  keyNone: string;
  keyConfigured: string;
  keyKeep: string;
  keyPasteExecutor: string;
  keyPasteReviewer: string;
  keyPasteSummary: string;
  keyPasteScopus: string;
  keyPasteOpenalex: string;
  keyPasteBraveSearch: string;
  keyPasteExa: string;
  keyPasteZhihuAccessSecret: string;
  keyNoSavedSecret: string;
  keyHideSecret: string;
  keyShowSecret: string;
  keyHide: string;
  keyShow: string;
  managedModelServerLabel: string;
  serverNotConfigured: string;
  unknownLabel: string;
  executorProviderLabels: Record<string, string>;
  executorProviderHints: Record<string, string>;
  reviewerProviderLabels: Record<string, string>;
  reviewerProviderHints: Record<string, string>;
  summaryAutoLabel: string;
  summaryAutoHint: string;
  summaryFastHint: string;
  summaryOffLabel: string;
  summaryOffHint: string;
  summaryProviderExecutor: string;
  summaryProviderReviewer: string;
  protocolOpenAiCompatible: string;
  protocolAnthropicCompatible: string;
  officialDefaultPlaceholder: string;
  providerDefaultPlaceholder: string;
  automaticPlaceholder: string;
  previewConnectionTest: string;
  previewExecutorLabel: string;
  previewReviewerLabel: string;
  previewSettingsLabel: string;
  previewMode: string;
}

export interface SettingsProfileCopy {
  signedOut: string;
  statCumulative: string;
  statPeak: string;
  statLongestTask: string;
  statCurrentStreak: string;
  statLongestStreak: string;
  tokenUnit: string;
  days: (n: number) => string;
  activityTitle: string;
  modeDaily: string;
  modeWeekly: string;
  modeCumulative: string;
  activityEmpty: string;
  activitySince: (date: string) => string;
  insightsTitle: string;
  insightFastMode: string;
  insightReasoning: string;
  insightSkills: string;
  insightTools: string;
  topSkillsTitle: string;
  topSkillsEmpty: string;
  runs: (n: number) => string;
  accruing: string;
  metaHint: string;
  loading: string;
  compactBillions: (value: string) => string;
  compactMillions: (value: string) => string;
  compactThousands: (value: string) => string;
  compactHundredMillions: (value: string) => string;
  compactTenThousands: (value: string) => string;
  durationHoursMinutes: (hours: number, minutes: number) => string;
  durationMinutes: (minutes: number) => string;
  durationSeconds: (seconds: number) => string;
}

export interface SettingsMailCopy {
  /** Shown instead of a native IPC error when the app runs in browser preview. */
  desktopOnly: string;
  connected: string;
  notConnected: string;
  accountSummaryEmpty: string;
  accountSummary: (connected: number, total: number) => string;
  detailTitle: string;
  detailSub: string;
  connectedCount: (count: number) => string;
  oauthTitle: string;
  oauthSub: string;
  connecting: string;
  genericTitle: string;
  genericSub: string;
  emailAddress: string;
  displayName: string;
  displayNamePlaceholder: string;
  discoverTitle: string;
  discoverSub: string;
  discoverUsed: (source: string, notes: string[]) => string;
  discovering: string;
  discover: string;
  defaultEmail: string;
  passwordPlaceholder: string;
  enableSmtp: string;
  enableSmtpSub: string;
  defaultImapUser: string;
  reuseImapPassword: string;
  testTesting: string;
  testConnection: string;
  connectMailbox: string;
  connectedAccounts: string;
  connectedAccountsSub: string;
  disconnect: string;
  noConnectedAccounts: string;
  emailRequired: string;
  gmailNotice: string;
  outlookNotice: string;
  neteaseNotice: string;
  providerApiBadge: string;
  continueWithGmail: string;
  continueWithOutlook: string;
  mailboxConnectedMessage: string;
  incomingImapTitle: string;
  outgoingSmtpTitle: string;
  fieldHost: string;
  fieldPort: string;
  fieldSecurity: string;
  fieldUsername: string;
  fieldPassword: string;
  disconnectedSuffix: string;
  securityNoneOption: string;
}

export interface SettingsRemoteCopy {
  title: string;
  subtitle: string;
  /** Sub-tab labels: phones pair by QR, computers pair by one-time code. */
  tabPhones: string;
  tabComputers: string;
  tabPhonesHint: string;
  tabComputersHint: string;
  pairingFlowTitle: string;
  refresh: string;
  refreshing: string;
  enabled: string;
  disabled: string;
  enabledDescription: string;
  disabledDescription: string;
  connectPhone: string;
  connectingPhone: string;
  refreshPairing: string;
  refreshingPairing: string;
  disable: string;
  disabling: string;
  desktopIdentity: string;
  pairingTitle: string;
  pairingDescription: string;
  pairingExpires: (time: string) => string;
  waitingForPhone: string;
  checkPairingRequest: string;
  checkingPairingRequest: string;
  pairingRequest: string;
  requestedBy: string;
  approvePairing: string;
  approvingPairing: string;
  discardPairing: string;
  discardingPairing: string;
  pairingPreview: string;
  devicesTitle: string;
  devicesSummary: (active: number, paired: number) => string;
  noDevices: string;
  paired: string;
  revoked: string;
  fingerprint: string;
  permissions: string;
  pairedAt: string;
  lastSeen: string;
  never: string;
  revoke: string;
  revokePrompt: string;
  revokeConfirm: string;
  cancel: string;
  revoking: string;
  loadFailed: string;
  enabledPreview: string;
  scopeLabels: Record<RemoteScope, string>;
}

export interface SettingsComputeNodeCopy {
  transportRelay: string;
  transportLan: string;
  transportSecureFallback: string;
  peerNeverConnected: string;
  peerTimestampUnknown: string;
  pairingRequestArrived: string;
  connectionCodeExpired: string;
  computerPairingCompleted: string;
  pairingApprovalExpired: string;
  previewNoRealInvitation: string;
  invitationCreatedMessage: string;
  connectionCodeCopied: string;
  connectionAllowedMessage: string;
  connectionDeclinedMessage: string;
  previewNoRealClaim: string;
  claimSentMessage: string;
  pairingRevokedMessage: string;
  establishingConnection: string;
  loadingComputeNode: string;
  title: string;
  subtitle: string;
  badgeAccepting: string;
  badgeLocalOnly: string;
  nodeNameLabel: string;
  copyNodeId: string;
  nodeIdCopied: string;
  maxParallelJobsLabel: string;
  detectingCapabilities: string;
  acceptRemoteJobsTitle: string;
  acceptRemoteJobsDesc: string;
  acceptRemoteAgentChatsTitle: string;
  acceptRemoteAgentChatsDesc: string;
  pairComputersTitle: string;
  pairComputersDesc: string;
  inviteFromThisComputer: string;
  inviteFromThisComputerDesc: string;
  createConnectionCode: string;
  oneTimeConnectionCode: string;
  copyCode: string;
  waitingForOtherComputer: string;
  regenerate: string;
  joinAnotherComputer: string;
  joinAnotherComputerDesc: string;
  pasteConnectionCodeHere: string;
  claimInvitation: string;
  waitingForApprovalThenAuto: string;
  allowThisComputerTitle: string;
  approvalDescription: (label: string) => string;
  deviceLabel: string;
  deviceFingerprintLabel: string;
  requestedAccessLabel: string;
  requestedAccessDesc: string;
  decline: string;
  workingEllipsis: string;
  allowConnection: string;
  pairedComputeNodesTitle: string;
  computersCount: (count: number) => string;
  noOtherComputersPaired: string;
  canRemoteJobsAndChat: string;
  computeJobsOnly: string;
  nodeColumnHeader: string;
  statusColumnHeader: string;
  systemColumnHeader: string;
  lastOnlineColumnHeader: string;
  actionColumnHeader: string;
  online: string;
  offline: string;
  connectingAriaLabel: (name: string) => string;
  revokingAriaLabel: (name: string) => string;
  moreActionsAriaLabel: (name: string) => string;
  connect: string;
  connectKeychainHint: string;
  revokePairing: string;
  revokePairingHint: string;
}

export interface SettingsMemoryExplorerCopy {
  layerNames: Record<"l0" | "l1" | "l2" | "l3", string>;
  editMemoryContentAriaLabel: string;
  collapseFull: string;
  expandFull: string;
  contextLabel: string;
  artifactsLabel: string;
  sourceEventsLabel: string;
  knowledgeUpdateLabel: string;
  supersedes: string;
  sourceSessionLabel: string;
  noSourceSessionRecorded: string;
  saveCorrection: string;
  cancel: string;
  edit: string;
  delete: string;
  deleteConfirm: string;
  title: string;
  subtitle: string;
  loadingEllipsis: string;
  refreshLibrary: string;
  memoryLayersAriaLabel: string;
  searchPlaceholder: string;
  clear: string;
  search: string;
  somePartialUnavailable: string;
  searchResults: string;
  resultsCount: (count: number) => string;
  noMatchingMemories: string;
  layerEmptyContent: string;
  researchEpisodesAriaLabel: string;
  untitledEpisode: string;
  noResearchEpisodesYet: string;
  episodeEmpty: string;
  selectEpisodeToInspect: string;
  readOnlyConsolidatedFooter: string;
  coreProfile: string;
  derivedFromTracedFooter: string;
  coreProfileNotGenerated: string;
  loadedLabel: string;
  entriesPerLayerNote: (limit: number) => string;
}

export interface SettingsMemoryRecallPreviewCopy {
  layerLabel: Record<"R0" | "R1" | "R2" | "R3", string>;
  reasonLabel: Record<"duplicate" | "budget" | "not_standing", string>;
  matchLabel: string;
  title: string;
  subtitle: string;
  queryPlaceholder: string;
  queryAriaLabel: string;
  assembling: string;
  previewRecall: string;
  charsInjected: string;
  budgetAllocationAriaLabel: string;
  injectionLayersTitle: string;
  injectionLayersSubtitle: string;
  charsUnit: string;
  injectedCountLabel: (kept: number, candidates: number) => string;
  sharedRemainingBudget: string;
  nothingRecalled: string;
  injected: string;
  dropped: string;
  nothingDropped: string;
  hide: string;
  raw: string;
}

export interface SettingsMemoryCopy {
  requeuedTasks: (restored: number) => string;
  exportedTo: (path: string) => string;
  unavailable: string;
  loadingStatus: string;
  researchMemoryTitle: string;
  pending: string;
  refresh: string;
  tasksNeedingAttention: (count: number) => string;
  deadLetterSubtitle: string;
  requeuingEllipsis: string;
  requeue: string;
  attemptsLabel: string;
  rederiveTitle: string;
  rederiveSubtitle: string;
  rederiveStaleAtoms: (count: number) => string;
  rederiveConfirm: string;
  rederiveButton: string;
  rederivingEllipsis: string;
  rederiveSummary: (replayed: number, written: number, preserved: number) => string;
  backfillHistoryTitle: string;
  backfillSubtitle: string;
  previewButton: string;
  cancel: string;
  exportMemory: string;
  previewSummaryLabel: string;
  alreadyBackfilled: string;
  completedLabel: string;
  cancelledLabel: string;
}

export interface SettingsNavCopy {
  labels: {
    profile: string;
    general: string;
    account: string;
    models: string;
    memory: string;
    mail: string;
    remote: string;
    extensions: string;
    environment: string;
    about: string;
  };
  groupLabels: {
    personal: string;
    integration: string;
    system: string;
  };
  misc: {
    back: string;
  };
}

export interface SettingsCopy {
  general: SettingsGeneralCopy;
  providers: SettingsProvidersCopy;
  profile: SettingsProfileCopy;
  mail: SettingsMailCopy;
  remote: SettingsRemoteCopy;
  computeNode: SettingsComputeNodeCopy;
  memoryExplorer: SettingsMemoryExplorerCopy;
  memoryRecallPreview: SettingsMemoryRecallPreviewCopy;
  memory: SettingsMemoryCopy;
  nav: SettingsNavCopy;
}

export const ADMIN_ACCOUNT_EXACT_MARKERS = [
  "admin",
  "administrator",
  "root",
  "superuser",
  "super-admin",
  "owner",
] as const;

export const ADMIN_ACCOUNT_CONTAINS_MARKERS = ["管理员", "管理員"] as const;

export const SETTINGS_COPY: Record<Language, SettingsCopy> = {
  cn: {
    general: {
      settingsCategories: "设置分类",
      loading: "加载中...",
      statusModelService: "模型服务",
      statusVersion: "版本",
      languageTitle: "界面语言",
      languageSub: "立即切换桌面界面语言；保存后也会作为助手回复偏好。",
      saveSaving: "保存中...",
      saveSaved: "已保存",
      savePrefs: "保存偏好",
      appearanceTitle: "外观主题",
      appearanceSub: "选择应用的明暗主题，立即生效。",
      themeLabel: "主题",
      light: "浅色",
      dark: "深色",
      localBehaviorTitle: "本地行为",
      localBehaviorSub: "记忆写入策略仅保存在这台设备。",
      confirmBeforeWrite: "写入前确认",
      autoWrite: "自动写入",
      saveBehavior: "保存行为",
      systemPromptTitle: "系统提示词",
      systemPromptSub: "普通对话使用的只读提示词预览。",
      userPromptTitle: "用户提示词",
      userPromptSub: "最近一次从对话或代理界面实际发送的用户提示词。",
      promptView: "查看",
      promptHide: "收起",
      promptModel: "模型",
      promptUnknown: "未知",
      promptSections: (count) => `${count} 个段落`,
      promptChars: (count) => `${count} 字符`,
      promptFullTools: "完整工具",
      promptLimitedTools: "有限工具",
      promptLoading: "加载中...",
      promptRefresh: "刷新",
      systemPromptLoading: "正在加载系统提示词...",
      userPromptEmpty: "这个应用会话中还没有发送过用户提示词。",
      userPromptSource: "来源",
      userPromptNoSource: "无",
      userPromptNotCaptured: "尚未捕获",
      userPromptBlocks: (count) => `${count} 个文本块`,
      userPromptImages: (count) => `${count} 张图片`,
      userPromptLoading: "正在加载用户提示词...",
      creditUnit: "额度",
      accountUsedQuota: "当前账号已用额度",
      accountBalance: "账户余额",
      accountTotalQuota: "账户总额度",
      accountUsageRatio: "账户消耗比例",
      subscriptionUsed: "订阅已用",
      subscriptionBalance: "订阅余额",
      subscriptionUsageRatio: "订阅消耗比例",
      callDetails: "调用明细",
      usageRange: (start, end, total) => `第 ${start}-${end} 条 / 共 ${total} 条`,
      usageNoRecords: "暂无记录",
      usageLoading: "加载中...",
      usageStatusSuccess: "成功",
      usageStatusFailed: "失败",
      usageTypeConsume: "消耗",
      usageHeaders: { time: "时间", model: "模型", token: "令牌", tokens: "令牌数", quota: "额度", request: "请求" },
      usagePageSummary: (pageSize, page, pageCount) => `每页 ${pageSize} 条，当前第 ${page} / ${pageCount} 页`,
      usagePrev: "上一页",
      usageNext: "下一页",
      usageEmpty: "暂无调用记录。",
      authAccountTitle: "账户与用量",
      authAccountSub: "账号、订阅、分组、额度与调用明细由服务器同步，本地仅保留最近一次投影。",
      authRefresh: "刷新",
      authRefreshing: "刷新中...",
      authLogout: "退出登录",
      authSignedIn: "已登录",
      authSignedOut: "未登录",
      authSignedOutSub: "登录后显示账号信息",
      authSubscriptionLabel: "订阅套餐",
      authGroupTag: (group) => `分组 ${group}`,
      authRefreshFailed: (error) => `刷新失败，当前显示上次缓存 · ${error}`,
      aboutUpdateTitle: "应用更新",
      aboutUpdateSub: "通过 GitHub Release 检查、下载并安装 SomniQ Studio 更新。",
      aboutCheck: "检查更新",
      aboutChecking: "检查中...",
      aboutDownloadInstall: "下载并安装",
      aboutRestart: "重启应用",
      aboutUpdateAvailable: (version) => `可更新到 v${version}`,
      aboutUpdateReady: (version) => `v${version} 已安装`,
      aboutInstalling: "正在安装更新",
      aboutConnected: "SomniQ Studio 已连接更新通道",
      aboutCurrentVersion: (version) => `当前版本 v${version}`,
      aboutRemoteVersion: (version) => `远端版本 v${version}`,
      envTitle: "本地环境检查",
      envDetectingSub: "正在检测本机运行环境...",
      envReadySummary: (ready, total, checkedAt) => `${ready}/${total} 项可用${checkedAt ? ` · 上次检测 ${checkedAt}` : ""}`,
      envSub: "查看 Python、MATLAB、LaTeX 等运行环境。",
      envRefresh: "刷新",
      envDetecting: "检测中...",
      pythonEnvironmentTitle: "首选 Python / Conda 环境",
      pythonEnvironmentHint: "显式信任一个本机环境目录。SomniQ 会优先使用其中的 Python、Conda 和 Jupyter，并让新启动的 Chat 命令与 Lab 内核继承该路径。",
      pythonEnvironmentPlaceholder: "例如 C:\\Users\\name\\anaconda3 或环境中的 python.exe",
      pythonEnvironmentBrowseTitle: "选择 Python、Anaconda 或 Conda 环境目录",
      pythonEnvironmentBrowse: "选择目录",
      pythonEnvironmentUse: "使用此环境",
      pythonEnvironmentSaving: "正在应用...",
      pythonEnvironmentSaved: "已应用",
      envEmpty: "点击刷新后显示本机可用的科研与排版运行环境。",
      envStatusReady: "可用",
      envStatusWarning: "需检查",
      envStatusMissing: "未检测到",
      envVersion: "版本",
      envPath: "路径",
      envUnknownVersion: "未获取",
      envNotOnPath: "未加入 PATH",
      envInstallInChat: "前往对话安装",
      envCategories: { python: "运行环境", jupyter: "笔记本", matlab: "数值计算", latex: "论文排版" },
      envExecutableWarning: "已找到可执行文件，但版本检查未完成。",
      envAvailable: "已检测到可用环境。",
      envMissingInstallable: (label) => `未检测到 ${label}，可以转到对话完成安装与验证。`,
      envMissing: (label) => `未检测到 ${label}。`,
      aboutLinksTitle: "资源链接",
      aboutLinksSub: "源码、更新日志与许可协议。",
      aboutLinkRepo: "GitHub 仓库",
      aboutLinkReleases: "更新日志",
      aboutLinkLicense: "许可协议",
      updateMsgNewVersion: (version) => `发现新版本 v${version}`,
      updateMsgUpToDate: "当前已是最新版本",
      updateMsgDownloading: "正在下载安装包",
      updateMsgInstalled: "更新已安装，重启后生效",
      updateMsgNoUpdateToInstall: "没有可安装的更新",
      updateDownloaded: (size) => `已下载 ${size}`,
      groupLabel: "调用分组",
      groupHint: "切换后会把桌面端令牌改到该分组，按新倍率计费，并重新同步额度与模型。",
      groupSave: "保存分组",
      groupSaving: "保存中...",
      groupLoading: "正在加载分组...",
      groupEmpty: "暂无可选分组",
      previewConfigPath: "浏览器预览 — 未加载 Tauri 配置",
      previewDisplayName: "预览用户",
      previewSubscriptionName: "团队套餐",
      previewSubscriptionDescription: "浏览器预览数据",
      previewStandardGroupDescription: "标准分组",
      previewResearchGroupDescription: "研究路由",
      previewPremiumGroupDescription: "高级路由",
      previewUsageType: "消耗",
      previewSystemPrompt: "# 系统\n预览模式：Tauri 未连接，因此无法显示实时系统提示词。\n\n# 环境上下文\n - 模型：MiniMax-M3\n - 工作目录：浏览器预览\n\n# 桌面对话\n完整工具注册表：已启用。",
      previewUserPrompt: "预览模式：此面板显示最近一次从对话输入框发送的用户提示词。",
      previewUserPromptSurface: "对话",
    },
    providers: {
      currentModelFallback: "未选择",
      modelServiceTitle: "模型服务",
      modelServiceSub: "从账号已有模型中分别选择对话执行模型和 Reviewer 模型；对话中也可以临时切换任意已同步模型。",
      modelSync: "同步模型",
      modelSyncing: "同步中...",
      executorModel: "执行模型",
      executorModelHint: "留空时显示的是默认模型，尚未真正保存",
      transportResponses: "Responses 接口",
      transportChat: "Chat 接口",
      transportHint: "接口能力在“测试连接”时探测；不支持时会在首次请求后自动回退。",
      reviewerModel: "Reviewer 模型",
      reviewerModelHint: "留空时显示的是默认模型，尚未真正保存",
      reviewerModelOff: "关闭 Reviewer 模型",
      modelSyncAfterLogin: "登录后同步模型",
      currentExecutor: (model) => `当前执行：${model}`,
      currentReviewer: (model) => ` · Reviewer：${model}`,
      reviewerOff: " · Reviewer：关闭",
      modelSyncingStatus: "正在同步模型",
      modelSynced: (count) => `已同步 ${count} 个模型`,
      modelSyncAfterLoginStatus: "登录后将自动同步模型",
      advancedExecutor: "执行器",
      advancedReviewer: "Reviewer",
      advancedProviderType: "供应商类型",
      advancedSummaryTools: "摘要与研究服务",
      advancedSummaryToolsSub: "摘要与检索卡模型，以及 Scopus、Brave Search、Exa 服务密钥",
      advancedCollapse: "收起",
      advancedExpand: "展开",
      summaryProvider: "摘要供应商",
      summaryProviderHint: "自动模式会使用这里选择的供应商和已保存的密钥",
      summaryFollowExecutor: "跟随执行器",
      summaryManual: "手动配置",
      summaryProtocol: "摘要协议",
      summaryBaseUrl: "摘要 Base URL",
      summaryApiKey: "摘要 API Key",
      summaryModel: "摘要模型",
      summaryModelHint: "压缩上下文时生成摘要所用的模型；留空即自动选择",
      retrievalCardModel: "检索卡生成模型",
      retrievalCardModelHint: "用于从 PDF 页块提取概念、别名、双语术语和潜在问题；留空则跟随执行模型，仅影响后续生成或重建",
      retrievalCardFollowExecutor: "跟随执行模型",
      testTesting: TEST_TESTING_LABEL.cn,
      testConnectionConfig: "测试连接配置",
      saveConnectionConfig: "保存连接配置",
      saveConnectionSavedInfo: "已保存。下次对话时生效。",
      fieldModel: "模型",
      fieldBaseUrl: "接口地址",
      fieldApiKey: "API 密钥",
      fieldConfigFile: "配置文件",
      fieldScopusKey: "Scopus 密钥",
      fieldOpenalexKey: "OpenAlex 密钥",
      fieldBraveSearchKey: "Brave Search 密钥",
      fieldExaKey: "Exa 密钥",
      fieldZhihuAccessSecret: "知乎 Access Secret",
      clearProviderKeyConfirm: (secretLabel) => `确认清除已保存的${secretLabel}？`,
      zhihuSearchHint: "作为中文社区与本地经验的补充来源；结果会标记为社区观点。",
      fieldWebProxyUrl: "网页检索代理",
      webProxyHint: "可选；WebSearch 和 WebFetch 使用此 HTTP/HTTPS 代理，留空则直接联网。",
      webProxyPlaceholder: "例如 http://127.0.0.1:10808",
      presetCustom: "自定义 / 手动",
      presetOfficial: "官方",
      presetHints: {
        anthropic: "Anthropic",
        openaiCompatible: "OpenAI 兼容",
        googleOpenAiCompatible: "Google · OpenAI 兼容",
        zhipu: "智谱",
        minimax: "MiniMax",
        moonshot: "Moonshot",
        deepseek: "DeepSeek",
        dashscope: "DashScope",
        ark: "Ark",
        openai: "OpenAI",
        google: "Google",
        anthropicCompatible: "Anthropic 兼容",
      },
      keySaved: (masked) => `已保存：${masked}`,
      keyNone: "未设置密钥",
      keyConfigured: "已配置",
      keyKeep: "留空则保持不变",
      keyPasteExecutor: "粘贴 API 密钥",
      keyPasteReviewer: "粘贴 Reviewer 密钥",
      keyPasteSummary: "粘贴摘要模型密钥",
      keyPasteScopus: "粘贴 Elsevier 密钥",
      keyPasteOpenalex: "粘贴 OpenAlex API 密钥",
      keyPasteBraveSearch: "粘贴 Brave Search API 密钥",
      keyPasteExa: "粘贴 Exa API 密钥",
      keyPasteZhihuAccessSecret: "粘贴知乎开放平台 Access Secret",
      keyNoSavedSecret: "没有可显示的已保存密钥",
      keyHideSecret: "隐藏密钥",
      keyShowSecret: "显示密钥",
      keyHide: "隐藏",
      keyShow: "显示",
      managedModelServerLabel: "通用模型服务器",
      serverNotConfigured: "未配置",
      unknownLabel: "未知",
      executorProviderLabels: {
        anthropic: "Anthropic",
        "anthropic-compat": "Anthropic 兼容",
        openai: "OpenAI 兼容",
        custom: "自定义",
      },
      executorProviderHints: {
        anthropic: "Claude 官方 API",
        "anthropic-compat": "Claude 兼容的自定义端点",
        openai: "OpenAI、MiniMax、DeepSeek、Kimi…",
        custom: "任意其他供应商",
      },
      reviewerProviderLabels: {
        "": "停用",
        openai: "OpenAI 兼容",
        gemini: "Gemini",
        glm: "GLM",
        minimax: "MiniMax",
        kimi: "Kimi",
        deepseek: "DeepSeek",
        "anthropic-compat": "Anthropic 兼容",
        custom: "自定义",
      },
      reviewerProviderHints: {
        "": "不使用独立的 Reviewer 模型",
        openai: "OpenAI 或兼容的 Reviewer API",
        gemini: "Google",
        glm: "智谱",
        minimax: "MiniMax Reviewer",
        kimi: "Moonshot Reviewer",
        deepseek: "DeepSeek Anthropic 兼容 Reviewer",
        "anthropic-compat": "Claude 兼容的 Reviewer / 代理",
        custom: "手动指定供应商与端点",
      },
      summaryAutoLabel: "自动",
      summaryAutoHint: "自动选择",
      summaryFastHint: "经济快速",
      summaryOffLabel: "关闭",
      summaryOffHint: "不使用 LLM 摘要",
      summaryProviderExecutor: "执行器",
      summaryProviderReviewer: "Reviewer",
      protocolOpenAiCompatible: "OpenAI 兼容",
      protocolAnthropicCompatible: "Anthropic 兼容",
      officialDefaultPlaceholder: "（官方默认值）",
      providerDefaultPlaceholder: "（供应商默认值）",
      automaticPlaceholder: "自动",
      previewConnectionTest: "浏览器预览：连接测试为模拟结果。",
      previewExecutorLabel: "执行器",
      previewReviewerLabel: "Reviewer",
      previewSettingsLabel: "设置",
      previewMode: "预览模式",
    },
    profile: {
      signedOut: "未登录",
      statCumulative: "累计令牌数",
      statPeak: "峰值令牌数",
      statLongestTask: "最长任务时长",
      statCurrentStreak: "当前连续天数",
      statLongestStreak: "最长连续天数",
      tokenUnit: "令牌",
      days: (n) => `${n} 天`,
      activityTitle: "令牌活动",
      modeDaily: "每日",
      modeWeekly: "每周",
      modeCumulative: "累计",
      activityEmpty: "还没有活动记录，用几次对话后这里会显示令牌活跃热力图。",
      activitySince: (date) => `自 ${date} 起`,
      insightsTitle: "活动洞察",
      insightFastMode: "快速模式",
      insightReasoning: "最常用的推理强度",
      insightSkills: "已探索的技能",
      insightTools: "工具调用",
      topSkillsTitle: "最常用的插件",
      topSkillsEmpty: "尚无技能调用记录。",
      runs: (n) => `${n} 次运行`,
      accruing: "累积中",
      metaHint: "开启元数据日志后统计更完整",
      loading: "加载中…",
      compactBillions: (value) => `${value}B`,
      compactMillions: (value) => `${value}M`,
      compactThousands: (value) => `${value}K`,
      compactHundredMillions: (value) => `${value}亿`,
      compactTenThousands: (value) => `${value}万`,
      durationHoursMinutes: (hours, minutes) => `${hours} 小时 ${minutes} 分`,
      durationMinutes: (minutes) => `${minutes} 分`,
      durationSeconds: (seconds) => `${seconds} 秒`,
    },
    mail: {
      desktopOnly: "邮箱连接需要桌面后端 — 请运行 `npm run tauri dev`（浏览器预览不会连接任何邮箱）",
      connected: "已连接",
      notConnected: "未连接",
      accountSummaryEmpty: "尚未连接邮箱",
      accountSummary: (connected, total) => `${connected}/${total} 个账户已连接`,
      detailTitle: "邮箱连接",
      detailSub: "Gmail 和 Outlook 使用 OAuth/API。通用 IMAP/SMTP 仅用于仍支持授权码或应用专用密码的邮箱。",
      connectedCount: (count) => `${count} 个已连接`,
      oauthTitle: "Gmail / Outlook 推荐连接方式",
      oauthSub: "个人 Gmail、Outlook.com 和 Microsoft 365 应使用 OAuth/API。不要在下面的通用 IMAP 表单里输入普通账户密码。",
      connecting: "连接中...",
      genericTitle: "通用 IMAP/SMTP",
      genericSub: "先输入邮箱地址，自动发现服务器；再输入服务商授权码或应用专用密码测试连接。",
      emailAddress: "邮箱地址",
      displayName: "显示名称",
      displayNamePlaceholder: "发件时显示",
      discoverTitle: "自动发现 IMAP/SMTP",
      discoverSub: "按 Thunderbird Autoconfig、Thunderbird ISPDB、内置服务商规则和通用域名猜测依次查找配置。",
      discoverUsed: (source, notes) => `已使用：${source}${notes.length > 0 ? ` · ${notes.join(" ")}` : ""}`,
      discovering: "发现中...",
      discover: "自动发现",
      defaultEmail: "默认使用邮箱地址",
      passwordPlaceholder: "密码或应用专用密码",
      enableSmtp: "启用 SMTP 发件",
      enableSmtpSub: "关闭后对话只能读取和整理邮件。",
      defaultImapUser: "默认复用 IMAP 用户名",
      reuseImapPassword: "留空复用 IMAP 密码",
      testTesting: TEST_TESTING_LABEL.cn,
      testConnection: "测试连接",
      connectMailbox: "连接邮箱",
      connectedAccounts: "已连接账户",
      connectedAccountsSub: "连接后，对话和邮件页面会复用同一个账户服务。",
      disconnect: "断开连接",
      noConnectedAccounts: "没有已连接的邮箱账户。",
      emailRequired: "请先输入邮箱地址。",
      gmailNotice: "Gmail 的普通 Google 密码不能用于 IMAP LOGIN。优先选择“使用 Gmail 继续”；只有已启用 IMAP 且生成了 Google 应用专用密码时，才使用下面的通用 IMAP/SMTP。",
      outlookNotice: "Outlook.com / Microsoft 365 的密码式 IMAP/SMTP 路径不可用。请使用“使用 Outlook 继续”的 OAuth/Graph 连接。",
      neteaseNotice: "网易邮箱需要先在网页端开启 IMAP/SMTP 服务，并使用客户端授权码作为密码。若出现 Unsafe Login，说明网易风控拒绝了当前客户端或登录环境，请先完成网页端安全验证，或联系 kefu@188.com。",
      providerApiBadge: "服务商 API",
      continueWithGmail: "使用 Gmail 继续",
      continueWithOutlook: "使用 Outlook 继续",
      mailboxConnectedMessage: "邮箱已连接。",
      incomingImapTitle: "收件 IMAP",
      outgoingSmtpTitle: "发件 SMTP",
      fieldHost: "服务器地址",
      fieldPort: "端口",
      fieldSecurity: "加密方式",
      fieldUsername: "用户名",
      fieldPassword: "密码",
      disconnectedSuffix: " · 已断开",
      securityNoneOption: "无 / 本地桥接",
    },
    remote: {
      title: "远程控制",
      subtitle: "让配对设备查看研究状态、继续桌面对话，或让另一台电脑代为执行任务；项目内容仍保留在当前电脑。",
      tabPhones: "手机",
      tabComputers: "电脑",
      tabPhonesHint: "扫码配对，远程查看与继续对话",
      tabComputersHint: "连接可信电脑，切换项目、对话与执行任务",
      pairingFlowTitle: "扫码配对手机",
      refresh: "刷新",
      refreshing: "刷新中…",
      enabled: "已启用",
      disabled: "未启用",
      enabledDescription: "远程控制已启用。扫描下方二维码即可在手机上继续配对。",
      disabledDescription: "连接手机后会自动启用远程控制并显示一次性二维码。",
      connectPhone: "连接手机",
      connectingPhone: "正在准备二维码…",
      refreshPairing: "刷新二维码",
      refreshingPairing: "正在刷新二维码…",
      disable: "停用远程控制",
      disabling: "正在停用…",
      desktopIdentity: "桌面设备",
      pairingTitle: "配对需要本机明确批准",
      pairingDescription: "此页面不会手动授予任何设备权限。新的手机配对请求必须在这台电脑上经过验证并由你明确批准后，才会获得受限访问权限。",
      pairingExpires: (time) => `此配对二维码将在 ${time} 过期。`,
      waitingForPhone: "使用受信任的手机扫描二维码，然后在此检查请求。",
      checkPairingRequest: "检查手机请求",
      checkingPairingRequest: "正在检查…",
      pairingRequest: "等待批准的手机",
      requestedBy: "请求的权限",
      approvePairing: "批准配对",
      approvingPairing: "正在批准…",
      discardPairing: "作废二维码",
      discardingPairing: "正在作废…",
      pairingPreview: "浏览器预览会显示示例二维码，不会建立真实连接。",
      devicesTitle: "已配对设备",
      devicesSummary: (active, paired) => `${active} 台可用 / ${paired} 条配对记录`,
      noDevices: "尚无已配对设备。连接手机后，用受信任的手机扫描二维码，并在此电脑上明确批准。",
      paired: "已配对",
      revoked: "已撤销",
      fingerprint: "设备指纹",
      permissions: "允许的操作",
      pairedAt: "配对时间",
      lastSeen: "最近连接",
      never: "从未连接",
      revoke: "撤销",
      revokePrompt: "撤销后，这台设备会立即失去远程访问权限。",
      revokeConfirm: "确认撤销设备",
      cancel: "取消",
      revoking: "正在撤销…",
      loadFailed: "无法加载远程控制状态。",
      enabledPreview: "浏览器预览：远程代理状态仅为模拟，不会建立连接。",
      scopeLabels: {
        read_project_state: "查看项目状态",
        read_task_timeline: "查看任务时间线",
        send_chat_messages: "查看、继续并执行桌面对话任务",
        stop_runs: "停止运行",
        read_review_conclusions: "查看审核结论",
        compute_jobs: "交换并执行计算任务",
      },
    },
    computeNode: {
      transportRelay: "服务器加密中继",
      transportLan: "局域网直连（旧版）",
      transportSecureFallback: "安全连接",
      peerNeverConnected: "从未连接",
      peerTimestampUnknown: "未知",
      pairingRequestArrived: "已收到另一台电脑的配对请求，请在弹窗中确认。",
      connectionCodeExpired: "一次性连接码已过期，请重新生成。",
      computerPairingCompleted: "电脑配对完成，正在建立安全连接。",
      pairingApprovalExpired: "配对批准等待已过期，请重新提交连接码。",
      previewNoRealInvitation: "预览模式不会创建真实邀请。",
      invitationCreatedMessage: "复制一次性连接码到另一台电脑。正在自动等待对方提交，收到后会弹出确认。",
      connectionCodeCopied: "一次性连接码已复制。",
      connectionAllowedMessage: "已允许连接。另一台电脑会自动完成配对。",
      connectionDeclinedMessage: "已拒绝连接，本次一次性连接码已作废。",
      previewNoRealClaim: "预览模式不会提交真实配对。",
      claimSentMessage: "请求已发送，正在等待邀请方确认；批准后会自动完成配对。",
      pairingRevokedMessage: "计算节点配对已撤销。",
      establishingConnection: "正在建立安全连接…",
      loadingComputeNode: "正在加载计算节点…",
      title: "电脑计算节点",
      subtitle: "让已配对电脑互相提交代码任务。任务在独立进程中运行，日志、退出状态和产物清单都会持久化并回传。",
      badgeAccepting: "接收任务",
      badgeLocalOnly: "仅本机",
      nodeNameLabel: "节点名称",
      copyNodeId: "复制节点 ID",
      nodeIdCopied: "节点 ID 已复制。",
      maxParallelJobsLabel: "最大并行任务",
      detectingCapabilities: "正在检测本机能力",
      acceptRemoteJobsTitle: "接受已配对电脑的远程代码任务",
      acceptRemoteJobsDesc: "关闭后仍可在本机运行持久化 Compute Job，但所有远端提交都会被拒绝。",
      acceptRemoteAgentChatsTitle: "允许已配对电脑与本机 Agent 对话",
      acceptRemoteAgentChatsDesc: "远程电脑会使用本机项目、模型和工具，并继续遵守本机权限策略；可与远程代码任务分别开关。",
      pairComputersTitle: "电脑配对",
      pairComputersDesc: "手机网关负责配对与 ICE 打洞信令；优先 WebRTC P2P，失败后自动切换到端到端加密的服务器中继。",
      inviteFromThisComputer: "从本机邀请",
      inviteFromThisComputerDesc: "生成并复制一次性连接码；电脑之间不使用二维码。",
      createConnectionCode: "生成一次性连接码",
      oneTimeConnectionCode: "一次性连接码",
      copyCode: "复制连接码",
      waitingForOtherComputer: "正在等待另一台电脑提交…",
      regenerate: "重新生成",
      joinAnotherComputer: "加入另一台电脑",
      joinAnotherComputerDesc: "粘贴另一台电脑生成的一次性连接码。",
      pasteConnectionCodeHere: "在这里粘贴连接码",
      claimInvitation: "提交配对声明",
      waitingForApprovalThenAuto: "等待邀请方确认，之后将自动完成…",
      allowThisComputerTitle: "允许这台电脑连接吗？",
      approvalDescription: (label) => `${label} 已提交刚才生成的一次性连接码。请核对设备指纹后决定。`,
      deviceLabel: "设备",
      deviceFingerprintLabel: "设备指纹",
      requestedAccessLabel: "请求权限",
      requestedAccessDesc: "远程 Agent 对话、读取项目列表、提交计算任务",
      decline: "拒绝",
      workingEllipsis: "处理中…",
      allowConnection: "允许连接",
      pairedComputeNodesTitle: "已配对计算节点",
      computersCount: (count) => `${count} 台电脑`,
      noOtherComputersPaired: "尚未配对其他电脑。",
      canRemoteJobsAndChat: "可执行远程任务和 Agent 对话",
      computeJobsOnly: "仅允许计算任务",
      nodeColumnHeader: "节点名称",
      statusColumnHeader: "状态",
      systemColumnHeader: "系统",
      lastOnlineColumnHeader: "最后在线",
      actionColumnHeader: "操作",
      online: "在线",
      offline: "离线",
      connectingAriaLabel: (name) => `正在连接 ${name}`,
      revokingAriaLabel: (name) => `正在撤销 ${name}`,
      moreActionsAriaLabel: (name) => `${name} 的更多操作`,
      connect: "连接",
      connectKeychainHint: "连接时会请求系统钥匙串授权",
      revokePairing: "撤销配对",
      revokePairingHint: "需要重新配对才能再次连接",
    },
    memoryExplorer: {
      layerNames: {
        l0: "权威对话",
        l1: "研究原子",
        l2: "研究情景",
        l3: "研究画像",
      },
      editMemoryContentAriaLabel: "编辑记忆内容",
      collapseFull: "收起全文",
      expandFull: "展开全文",
      contextLabel: "背景",
      artifactsLabel: "关联产物",
      sourceEventsLabel: "来源事件",
      knowledgeUpdateLabel: "知识更新",
      supersedes: "替代",
      sourceSessionLabel: "来源 Session",
      noSourceSessionRecorded: "没有记录来源 Session",
      saveCorrection: "保存修正",
      cancel: "取消",
      edit: "修正",
      delete: "删除",
      deleteConfirm: "删除这条派生记忆？SomniQ 权威 Session 不会被删除。",
      title: "科研记忆库",
      subtitle: "浏览当前项目的 R0 权威对话、R1 研究原子、R2 研究情景和 R3 研究画像，并下钻到来源。",
      loadingEllipsis: "载入中…",
      refreshLibrary: "刷新记忆库",
      memoryLayersAriaLabel: "记忆层级",
      searchPlaceholder: "搜索事实、结论或对话",
      clear: "清除",
      search: "搜索",
      somePartialUnavailable: "部分层级暂不可用",
      searchResults: "搜索结果",
      resultsCount: (count) => `${count} 条`,
      noMatchingMemories: "没有找到匹配记忆。",
      layerEmptyContent: "这一层还没有内容。",
      researchEpisodesAriaLabel: "研究情景",
      untitledEpisode: "未命名情景",
      noResearchEpisodesYet: "还没有研究情景。",
      episodeEmpty: "这个情景还没有内容。",
      selectEpisodeToInspect: "选择一个研究情景查看内容。",
      readOnlyConsolidatedFooter: "只读 · 由 R1 原子汇总而成；要修改请编辑对应的 R1 条目",
      coreProfile: "核心画像",
      derivedFromTracedFooter: "由已追踪来源的 R1 原子派生；Project Goal、Workflow 和证据库仍是独立权威。",
      coreProfileNotGenerated: "核心画像尚未生成。完成更多对话后会在后台更新。",
      loadedLabel: "最近加载",
      entriesPerLayerNote: (limit) => `每层仅显示最近 ${limit} 条；可搜索更早内容`,
    },
    memoryRecallPreview: {
      layerLabel: {
        R3: "项目画像",
        R1: "研究原子",
        R2: "研究情景",
        R0: "权威对话",
      },
      reasonLabel: {
        duplicate: "重复",
        budget: "超预算",
        not_standing: "非常驻",
      },
      matchLabel: "命中",
      title: "召回预览",
      subtitle: "看这一轮会注入什么、丢掉什么。不发送对话。",
      queryPlaceholder: "例如：上次实验的 p95 是多少",
      queryAriaLabel: "召回预览查询",
      assembling: "组装中…",
      previewRecall: "预览注入",
      charsInjected: "字已注入",
      budgetAllocationAriaLabel: "预算分配",
      injectionLayersTitle: "本次注入分层",
      injectionLayersSubtitle: "已用字数 / 预算 · 注入条数 / 候选条数",
      charsUnit: "字",
      injectedCountLabel: (kept, candidates) => `注入 ${kept} / ${candidates} 条`,
      sharedRemainingBudget: "共享剩余预算",
      nothingRecalled: "没有召回到记忆，本轮不注入。",
      injected: "注入",
      dropped: "丢弃",
      nothingDropped: "没有丢弃。",
      hide: "收起",
      raw: "原文",
    },
    memory: {
      requeuedTasks: (restored) => `已重新排队 ${restored} 条记忆任务`,
      exportedTo: (path) => `已导出到 ${path}`,
      unavailable: "不可用",
      loadingStatus: "读取中",
      researchMemoryTitle: "SomniQ 科研记忆",
      pending: "待提炼",
      refresh: "刷新",
      tasksNeedingAttention: (count) => `需要处理的记忆任务 (${count})`,
      deadLetterSubtitle: "这些记忆任务已重试多次仍未成功；原始会话不会被删除。重新排队会清零重试次数并立即再试一遍。",
      requeuingEllipsis: "重新排队中…",
      requeue: "重新排队",
      attemptsLabel: "次尝试",
      rederiveTitle: "重新提炼",
      rederiveSubtitle:
        "R1 只在对话结束时提炼一次，之后不再重算，所以提炼规则的改进不会自动应用到已有记忆。这里用当前规则重放全部已存对话；原始对话不动，你确认过的修正和删除过的条目都会保留。",
      rederiveStaleAtoms: (count) => `${count} 条记忆来自旧的提炼规则`,
      rederiveConfirm:
        "用当前的提炼规则重新生成 R1–R3？原始对话不会被修改，你确认过和删除过的记忆会保留。",
      rederiveButton: "重新提炼 R1–R3",
      rederivingEllipsis: "重放中…",
      rederiveSummary: (replayed, written, preserved) =>
        `已重放 ${replayed} 轮对话 · 重建 ${written} 条记忆 · 保留 ${preserved} 条人工确认`,
      backfillHistoryTitle: "回填历史",
      backfillSubtitle: "新完成的普通对话会自动提炼 R1–R3；这里用于安全回填已有历史。工作流 Session 会被排除，不修改或删除原始对话。",
      previewButton: "预览",
      cancel: "取消",
      exportMemory: "导出记忆",
      previewSummaryLabel: "待检查",
      alreadyBackfilled: "已回填",
      completedLabel: "完成",
      cancelledLabel: "已取消",
    },
    nav: {
      labels: {
        profile: "个人资料",
        general: "常规",
        account: "账户与用量",
        models: "模型服务",
        memory: "智能记忆",
        mail: "邮箱",
        remote: "远程控制",
        extensions: "插件",
        environment: "环境",
        about: "关于",
      },
      groupLabels: { personal: "个人", integration: "模型与集成", system: "系统" },
      misc: { back: "返回应用" },
    },
  },
  en: {
    general: {
      settingsCategories: "Settings categories",
      loading: "Loading...",
      statusModelService: "Model service",
      statusVersion: "Version",
      languageTitle: "Interface language",
      languageSub: "Switch the desktop UI immediately; save to also use it as the assistant reply preference.",
      saveSaving: "Saving...",
      saveSaved: "Saved",
      savePrefs: "Save preference",
      appearanceTitle: "Appearance",
      appearanceSub: "Choose the light or dark theme. Changes apply immediately.",
      themeLabel: "Theme",
      light: "Light",
      dark: "Dark",
      localBehaviorTitle: "Local behavior",
      localBehaviorSub: "Memory write behavior is stored only on this device.",
      confirmBeforeWrite: "Confirm before writing",
      autoWrite: "Write automatically",
      saveBehavior: "Save behavior",
      systemPromptTitle: "System prompt",
      systemPromptSub: "Read-only preview of the prompt used by normal Chat sessions.",
      userPromptTitle: "User prompt",
      userPromptSub: "Most recent user prompt actually sent from Chat or an agent surface.",
      promptView: "View",
      promptHide: "Hide",
      promptModel: "Model",
      promptUnknown: "Unknown",
      promptSections: (count) => `${count} sections`,
      promptChars: (count) => `${count} chars`,
      promptFullTools: "Full tools",
      promptLimitedTools: "Limited tools",
      promptLoading: "Loading...",
      promptRefresh: "Refresh",
      systemPromptLoading: "Loading system prompt...",
      userPromptEmpty: "No user prompt has been sent in this app session yet.",
      userPromptSource: "Source",
      userPromptNoSource: "None",
      userPromptNotCaptured: "Not captured",
      userPromptBlocks: (count) => `${count} blocks`,
      userPromptImages: (count) => `${count} images`,
      userPromptLoading: "Loading user prompt...",
      creditUnit: "credits",
      accountUsedQuota: "Account used",
      accountBalance: "Balance",
      accountTotalQuota: "Total quota",
      accountUsageRatio: "Account usage",
      subscriptionUsed: "Subscription used",
      subscriptionBalance: "Subscription balance",
      subscriptionUsageRatio: "Subscription usage",
      callDetails: "Call details",
      usageRange: (start, end, total) => `${start}-${end} of ${total}`,
      usageNoRecords: "No records",
      usageLoading: "Loading...",
      usageStatusSuccess: "Success",
      usageStatusFailed: "Failed",
      usageTypeConsume: "Consume",
      usageHeaders: { time: "Time", model: "Model", token: "Token", tokens: "Tokens", quota: "Quota", request: "Request" },
      usagePageSummary: (pageSize, page, pageCount) => `${pageSize} per page, page ${page} of ${pageCount}`,
      usagePrev: "Previous",
      usageNext: "Next",
      usageEmpty: "No usage records yet.",
      authAccountTitle: "Account & usage",
      authAccountSub: "Account, subscription, group, quota, and call details are synced from the server. This device keeps only the latest snapshot.",
      authRefresh: "Refresh",
      authRefreshing: "Refreshing...",
      authLogout: "Sign out",
      authSignedIn: "Signed in",
      authSignedOut: "Not signed in",
      authSignedOutSub: "Sign in to show account information",
      authSubscriptionLabel: "Subscription",
      authGroupTag: (group) => `Group ${group}`,
      authRefreshFailed: (error) => `Refresh failed. Showing cached data. ${error}`,
      aboutUpdateTitle: "App updates",
      aboutUpdateSub: "Check, download, and install SomniQ Studio updates from GitHub Releases.",
      aboutCheck: "Check for updates",
      aboutChecking: "Checking...",
      aboutDownloadInstall: "Download and install",
      aboutRestart: "Restart app",
      aboutUpdateAvailable: (version) => `Update available: v${version}`,
      aboutUpdateReady: (version) => `v${version} installed`,
      aboutInstalling: "Installing update",
      aboutConnected: "SomniQ Studio is connected to the update channel",
      aboutCurrentVersion: (version) => `Current version v${version}`,
      aboutRemoteVersion: (version) => `Remote version v${version}`,
      envTitle: "Local environment",
      envDetectingSub: "Checking local runtime environment...",
      envReadySummary: (ready, total, checkedAt) => `${ready}/${total} available${checkedAt ? ` · last checked ${checkedAt}` : ""}`,
      envSub: "Check Python, MATLAB, LaTeX, and other runtime tools.",
      envRefresh: "Refresh",
      envDetecting: "Checking...",
      pythonEnvironmentTitle: "Preferred Python / Conda environment",
      pythonEnvironmentHint: "Explicitly trust one local environment directory. SomniQ will prefer its Python, Conda, and Jupyter tools for new Chat commands and Lab kernels.",
      pythonEnvironmentPlaceholder: "For example C:\\Users\\name\\anaconda3 or an environment's python.exe",
      pythonEnvironmentBrowseTitle: "Choose a Python, Anaconda, or Conda environment directory",
      pythonEnvironmentBrowse: "Choose folder",
      pythonEnvironmentUse: "Use environment",
      pythonEnvironmentSaving: "Applying...",
      pythonEnvironmentSaved: "Applied",
      envEmpty: "Refresh to show available local research and typesetting tools.",
      envStatusReady: "Available",
      envStatusWarning: "Check required",
      envStatusMissing: "Not detected",
      envVersion: "Version",
      envPath: "Path",
      envUnknownVersion: "Unavailable",
      envNotOnPath: "Not on PATH",
      envInstallInChat: "Install with Chat",
      envCategories: { python: "Runtime", jupyter: "Notebook", matlab: "Numerical computing", latex: "Typesetting" },
      envExecutableWarning: "The executable was found, but its version check did not complete.",
      envAvailable: "The runtime is available.",
      envMissingInstallable: (label) => `${label} was not detected. Open Chat to install and verify it.`,
      envMissing: (label) => `${label} was not detected.`,
      aboutLinksTitle: "Resources",
      aboutLinksSub: "Source code, changelog, and license.",
      aboutLinkRepo: "GitHub repository",
      aboutLinkReleases: "Changelog",
      aboutLinkLicense: "License",
      updateMsgNewVersion: (version) => `New version available: v${version}`,
      updateMsgUpToDate: "You are on the latest version",
      updateMsgDownloading: "Downloading the installer",
      updateMsgInstalled: "Update installed. Restart to apply.",
      updateMsgNoUpdateToInstall: "No update available to install",
      updateDownloaded: (size) => `${size} downloaded`,
      groupLabel: "Routing group",
      groupHint: "Saving routes this desktop's token through that group, bills at its rate, then refreshes quota and models.",
      groupSave: "Save group",
      groupSaving: "Saving...",
      groupLoading: "Loading groups...",
      groupEmpty: "No groups available",
      previewConfigPath: "Browser preview — Tauri configuration is not loaded",
      previewDisplayName: "Preview user",
      previewSubscriptionName: "Team plan",
      previewSubscriptionDescription: "Browser preview data",
      previewStandardGroupDescription: "Standard group",
      previewResearchGroupDescription: "Research routing",
      previewPremiumGroupDescription: "Premium routing",
      previewUsageType: "Consume",
      previewSystemPrompt: "# System\nPreview mode: Tauri is not connected, so the live system prompt is unavailable.\n\n# Environment context\n - Model: MiniMax-M3\n - Working directory: browser preview\n\n# Desktop Chat\nFull tool registry: enabled.",
      previewUserPrompt: "Preview mode: this panel shows the most recent user prompt sent from the Chat composer.",
      previewUserPromptSurface: "Chat",
    },
    providers: {
      currentModelFallback: "Not selected",
      modelServiceTitle: "Model service",
      modelServiceSub: "Choose the chat execution model and review model from synced account models. Chat can also switch to any synced model temporarily.",
      modelSync: "Sync models",
      modelSyncing: "Syncing...",
      executorModel: "Execution model",
      executorModelHint: "Shown as a placeholder default; nothing is saved until you type a value",
      transportResponses: "Responses API",
      transportChat: "Chat API",
      transportHint: "Endpoint capability is probed by “Test connection”; unsupported endpoints fall back automatically after the first request.",
      reviewerModel: "Review model",
      reviewerModelHint: "Shown as a placeholder default; nothing is saved until you type a value",
      reviewerModelOff: "Disable review model",
      modelSyncAfterLogin: "Sync models after sign-in",
      currentExecutor: (model) => `Current executor: ${model}`,
      currentReviewer: (model) => ` · reviewer: ${model}`,
      reviewerOff: " · reviewer: off",
      modelSyncingStatus: "Syncing models",
      modelSynced: (count) => `${count} models synced`,
      modelSyncAfterLoginStatus: "Models will sync automatically after sign-in",
      advancedExecutor: "Executor",
      advancedReviewer: "Reviewer",
      advancedProviderType: "Provider type",
      advancedSummaryTools: "Summary and research services",
      advancedSummaryToolsSub: "Summary and retrieval-card models, plus Scopus, Brave Search, and Exa service keys",
      advancedCollapse: "Collapse",
      advancedExpand: "Expand",
      summaryProvider: "Summary provider",
      summaryProviderHint: "Auto uses the provider selected here and the saved key.",
      summaryFollowExecutor: "Follow executor",
      summaryManual: "Manual config",
      summaryProtocol: "Summary protocol",
      summaryBaseUrl: "Summary Base URL",
      summaryApiKey: "Summary API Key",
      summaryModel: "Summary model",
      summaryModelHint: "Model used to summarize compressed context; leave blank for Auto.",
      retrievalCardModel: "Retrieval-card model",
      retrievalCardModelHint: "Extracts concepts, aliases, bilingual terms, and likely questions from PDF chunks; blank follows the executor and changes apply to later generation or rebuilds.",
      retrievalCardFollowExecutor: "Follow execution model",
      testTesting: TEST_TESTING_LABEL.en,
      testConnectionConfig: "Test connection config",
      saveConnectionConfig: "Save connection config",
      saveConnectionSavedInfo: "Saved. Applies to the next chat.",
      fieldModel: "Model",
      fieldBaseUrl: "Base URL",
      fieldApiKey: "API Key",
      fieldConfigFile: "Config file",
      fieldScopusKey: "Scopus Key",
      fieldOpenalexKey: "OpenAlex Key",
      fieldBraveSearchKey: "Brave Search Key",
      fieldExaKey: "Exa Key",
      fieldZhihuAccessSecret: "Zhihu Access Secret",
      clearProviderKeyConfirm: (secretLabel) => `Clear the saved ${secretLabel}?`,
      zhihuSearchHint: "Supplements Chinese community and local-experience coverage; results remain labelled as community views.",
      fieldWebProxyUrl: "Research web proxy",
      webProxyHint: "Optional HTTP/HTTPS proxy for WebSearch and WebFetch; leave blank for direct access.",
      webProxyPlaceholder: "For example, http://127.0.0.1:10808",
      presetCustom: "Custom / manual",
      presetOfficial: "Official",
      presetHints: {
        anthropic: "Anthropic",
        openaiCompatible: "OpenAI-compatible",
        googleOpenAiCompatible: "Google OpenAI-compatible",
        zhipu: "Zhipu",
        minimax: "MiniMax",
        moonshot: "Moonshot",
        deepseek: "DeepSeek",
        dashscope: "DashScope",
        ark: "Ark",
        openai: "OpenAI",
        google: "Google",
        anthropicCompatible: "Anthropic-compatible",
      },
      keySaved: (masked) => `Saved: ${masked}`,
      keyNone: "No key",
      keyConfigured: "Configured",
      keyKeep: "Leave blank to keep",
      keyPasteExecutor: "Paste API key",
      keyPasteReviewer: "Paste reviewer key",
      keyPasteSummary: "Paste summary key",
      keyPasteScopus: "Paste Elsevier key",
      keyPasteOpenalex: "Paste OpenAlex API key",
      keyPasteBraveSearch: "Paste Brave Search API key",
      keyPasteExa: "Paste Exa API key",
      keyPasteZhihuAccessSecret: "Paste Zhihu Open Platform Access Secret",
      keyNoSavedSecret: "No saved key to reveal",
      keyHideSecret: "Hide key",
      keyShowSecret: "Show key",
      keyHide: "Hide",
      keyShow: "Show",
      managedModelServerLabel: "Managed model server",
      serverNotConfigured: "Not configured",
      unknownLabel: "Unknown",
      executorProviderLabels: {
        anthropic: "Anthropic",
        "anthropic-compat": "Anthropic-compatible",
        openai: "OpenAI-compatible",
        custom: "Custom",
      },
      executorProviderHints: {
        anthropic: "Claude official API",
        "anthropic-compat": "Claude-compatible custom endpoint",
        openai: "OpenAI, MiniMax, DeepSeek, Kimi...",
        custom: "Any other provider",
      },
      reviewerProviderLabels: {
        "": "Disabled",
        openai: "OpenAI-compatible",
        gemini: "Gemini",
        glm: "GLM",
        minimax: "MiniMax",
        kimi: "Kimi",
        deepseek: "DeepSeek",
        "anthropic-compat": "Anthropic-compatible",
        custom: "Custom",
      },
      reviewerProviderHints: {
        "": "Use no separate review model",
        openai: "OpenAI or compatible reviewer API",
        gemini: "Google",
        glm: "Zhipu",
        minimax: "MiniMax reviewer",
        kimi: "Moonshot reviewer",
        deepseek: "DeepSeek Anthropic-compatible reviewer",
        "anthropic-compat": "Claude-compatible reviewer/proxy",
        custom: "Manual provider and endpoint",
      },
      summaryAutoLabel: "Auto",
      summaryAutoHint: "Select automatically",
      summaryFastHint: "Fast and economical",
      summaryOffLabel: "Off",
      summaryOffHint: "Do not use LLM summaries",
      summaryProviderExecutor: "Executor",
      summaryProviderReviewer: "Reviewer",
      protocolOpenAiCompatible: "OpenAI-compatible",
      protocolAnthropicCompatible: "Anthropic-compatible",
      officialDefaultPlaceholder: "(official default)",
      providerDefaultPlaceholder: "(provider default)",
      automaticPlaceholder: "Auto",
      previewConnectionTest: "Browser preview: connection test is simulated.",
      previewExecutorLabel: "Executor",
      previewReviewerLabel: "Reviewer",
      previewSettingsLabel: "Settings",
      previewMode: "Preview mode",
    },
    profile: {
      signedOut: "Not signed in",
      statCumulative: "Cumulative tokens",
      statPeak: "Peak tokens",
      statLongestTask: "Longest task",
      statCurrentStreak: "Current streak",
      statLongestStreak: "Longest streak",
      tokenUnit: "tokens",
      days: (n) => `${n} d`,
      activityTitle: "Token activity",
      modeDaily: "Daily",
      modeWeekly: "Weekly",
      modeCumulative: "Cumulative",
      activityEmpty: "No activity yet — run a few chats and your Token heatmap will appear here.",
      activitySince: (date) => `Since ${date}`,
      insightsTitle: "Activity insights",
      insightFastMode: "Fast mode",
      insightReasoning: "Top reasoning effort",
      insightSkills: "Skills explored",
      insightTools: "Tool calls",
      topSkillsTitle: "Most used plugins",
      topSkillsEmpty: "No skill invocations recorded yet.",
      runs: (n) => `${n} runs`,
      accruing: "Accruing",
      metaHint: "Enable metadata logging for fuller stats",
      loading: "Loading…",
      compactBillions: (value) => `${value}B`,
      compactMillions: (value) => `${value}M`,
      compactThousands: (value) => `${value}K`,
      compactHundredMillions: (value) => `${value} hundred million`,
      compactTenThousands: (value) => `${value} ten thousand`,
      durationHoursMinutes: (hours, minutes) => `${hours}h ${minutes}m`,
      durationMinutes: (minutes) => `${minutes}m`,
      durationSeconds: (seconds) => `${seconds}s`,
    },
    mail: {
      desktopOnly: "Mail connections need the desktop backend — run `npm run tauri dev` (browser preview connects no mailbox)",
      connected: "Connected",
      notConnected: "Not connected",
      accountSummaryEmpty: "No mailbox connected",
      accountSummary: (connected, total) => `${connected}/${total} accounts connected`,
      detailTitle: "Mail connections",
      detailSub: "Gmail and Outlook use OAuth/API. Generic IMAP/SMTP is only for providers that still support app passwords or authorization codes.",
      connectedCount: (count) => `${count} connected`,
      oauthTitle: "Recommended for Gmail / Outlook",
      oauthSub: "Personal Gmail, Outlook.com, and Microsoft 365 should use OAuth/API. Do not enter a normal account password in the generic IMAP form below.",
      connecting: "Connecting...",
      genericTitle: "Generic IMAP/SMTP",
      genericSub: "Enter an email address to discover servers, then test with the provider authorization code or app password.",
      emailAddress: "Email address",
      displayName: "Display name",
      displayNamePlaceholder: "Shown when sending",
      discoverTitle: "Discover IMAP/SMTP",
      discoverSub: "Checks Thunderbird Autoconfig, Thunderbird ISPDB, built-in provider rules, and common domain guesses.",
      discoverUsed: (source, notes) => `Using: ${source}${notes.length > 0 ? ` · ${notes.join(" ")}` : ""}`,
      discovering: "Discovering...",
      discover: "Auto-discover",
      defaultEmail: "Defaults to email address",
      passwordPlaceholder: "Password or app password",
      enableSmtp: "Enable SMTP sending",
      enableSmtpSub: "When off, Chat can only read and organize mail.",
      defaultImapUser: "Defaults to IMAP username",
      reuseImapPassword: "Leave blank to reuse IMAP password",
      testTesting: TEST_TESTING_LABEL.en,
      testConnection: "Test connection",
      connectMailbox: "Connect mailbox",
      connectedAccounts: "Connected accounts",
      connectedAccountsSub: "After connecting, Chat and Mail reuse the same account service.",
      disconnect: "Disconnect",
      noConnectedAccounts: "No connected mail accounts.",
      emailRequired: "Enter an email address first.",
      gmailNotice: "A normal Google password cannot be used for Gmail IMAP LOGIN. Prefer Continue with Gmail; use generic IMAP/SMTP only after enabling IMAP and creating a Google app password.",
      outlookNotice: "Password-based IMAP/SMTP is unavailable for Outlook.com / Microsoft 365. Use Continue with Outlook for OAuth/Graph.",
      neteaseNotice: "NetEase mail requires IMAP/SMTP to be enabled in webmail and a client authorization code as the password. Unsafe Login means NetEase rejected this client or login environment.",
      providerApiBadge: "Provider API",
      continueWithGmail: "Continue with Gmail",
      continueWithOutlook: "Continue with Outlook",
      mailboxConnectedMessage: "Mailbox connected.",
      incomingImapTitle: "Incoming IMAP",
      outgoingSmtpTitle: "Outgoing SMTP",
      fieldHost: "Host",
      fieldPort: "Port",
      fieldSecurity: "Security",
      fieldUsername: "Username",
      fieldPassword: "Password",
      disconnectedSuffix: " · disconnected",
      securityNoneOption: "None / local bridge",
    },
    remote: {
      title: "Remote control",
      subtitle: "Let paired devices view research status, continue desktop conversations, or run tasks on another trusted computer while project data stays on this computer.",
      tabPhones: "Phones",
      tabComputers: "Computers",
      tabPhonesHint: "Pair by QR to view and continue conversations",
      tabComputersHint: "Connect trusted computers to switch projects, chat, and run tasks",
      pairingFlowTitle: "Scan to pair a phone",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      enabled: "Enabled",
      disabled: "Disabled",
      enabledDescription: "Remote control is enabled. Scan the QR code below to continue pairing on your phone.",
      disabledDescription: "Connect a phone to automatically enable remote control and show a one-time QR code.",
      connectPhone: "Connect phone",
      connectingPhone: "Preparing QR code…",
      refreshPairing: "Refresh pairing QR code",
      refreshingPairing: "Refreshing QR code…",
      disable: "Disable remote control",
      disabling: "Disabling…",
      desktopIdentity: "Desktop device",
      pairingTitle: "Pairing requires explicit desktop approval",
      pairingDescription: "This screen never grants a device manually. A new phone pairing request must be verified and explicitly approved on this desktop before it receives constrained access.",
      pairingExpires: (time) => `This pairing QR code expires ${time}.`,
      waitingForPhone: "Scan the code with a trusted phone, then check for its request here.",
      checkPairingRequest: "Check for phone request",
      checkingPairingRequest: "Checking…",
      pairingRequest: "Phone awaiting approval",
      requestedBy: "Requested permissions",
      approvePairing: "Approve pairing",
      approvingPairing: "Approving…",
      discardPairing: "Discard QR code",
      discardingPairing: "Discarding…",
      pairingPreview: "Browser preview shows a sample QR code and does not create a real connection.",
      devicesTitle: "Paired devices",
      devicesSummary: (active, paired) => `${active} active / ${paired} pairing records`,
      noDevices: "No devices are paired yet. Connect a phone, scan the QR code with a trusted device, then explicitly approve its request on this desktop.",
      paired: "Paired",
      revoked: "Revoked",
      fingerprint: "Device fingerprint",
      permissions: "Allowed actions",
      pairedAt: "Paired",
      lastSeen: "Last seen",
      never: "Never connected",
      revoke: "Revoke",
      revokePrompt: "Revoking immediately removes this device's remote access.",
      revokeConfirm: "Confirm device revocation",
      cancel: "Cancel",
      revoking: "Revoking…",
      loadFailed: "Unable to load remote-control status.",
      enabledPreview: "Browser preview: remote-agent state is simulated and no connection is opened.",
      scopeLabels: {
        read_project_state: "Project status",
        read_task_timeline: "Task timeline",
        send_chat_messages: "Desktop conversations and tasks",
        stop_runs: "Stop runs",
        read_review_conclusions: "Review conclusions",
        compute_jobs: "Exchange and execute compute jobs",
      },
    },
    computeNode: {
      transportRelay: "Encrypted server relay",
      transportLan: "LAN direct (legacy)",
      transportSecureFallback: "Secure",
      peerNeverConnected: "Never",
      peerTimestampUnknown: "Unknown",
      pairingRequestArrived: "A computer pairing request arrived. Confirm it in the dialog.",
      connectionCodeExpired: "The one-time connection code expired. Create a new one.",
      computerPairingCompleted: "Computer pairing completed. Establishing a secure connection.",
      pairingApprovalExpired: "Pairing approval expired. Submit a new connection code.",
      previewNoRealInvitation: "Preview mode does not create a real invitation.",
      invitationCreatedMessage: "Copy the one-time connection code to the other computer. Waiting automatically; a confirmation dialog will appear when they submit it.",
      connectionCodeCopied: "One-time connection code copied.",
      connectionAllowedMessage: "Connection allowed. The other computer will complete pairing automatically.",
      connectionDeclinedMessage: "Connection declined. This one-time connection code is no longer valid.",
      previewNoRealClaim: "Preview mode does not submit a real pairing.",
      claimSentMessage: "Request sent. Waiting for the inviting computer; pairing will complete automatically after approval.",
      pairingRevokedMessage: "Compute-node pairing revoked.",
      establishingConnection: "Establishing a secure connection…",
      loadingComputeNode: "Loading compute node…",
      title: "Computer compute node",
      subtitle: "Let paired computers submit code jobs to each other. Jobs run in separate processes with durable logs, exit status, and returned artifact manifests.",
      badgeAccepting: "Accepting jobs",
      badgeLocalOnly: "Local only",
      nodeNameLabel: "Node name",
      copyNodeId: "Copy node ID",
      nodeIdCopied: "Node ID copied.",
      maxParallelJobsLabel: "Maximum parallel jobs",
      detectingCapabilities: "Detecting local capabilities",
      acceptRemoteJobsTitle: "Accept remote code jobs from paired computers",
      acceptRemoteJobsDesc: "When disabled, local durable Compute Jobs remain available and all remote submissions are rejected.",
      acceptRemoteAgentChatsTitle: "Allow paired computers to talk to this Agent",
      acceptRemoteAgentChatsDesc: "Remote computers use this computer's projects, models, and tools under its local permission policy. This is independent from code jobs.",
      pairComputersTitle: "Pair computers",
      pairComputersDesc: "The mobile gateway coordinates pairing and ICE traversal; WebRTC P2P is preferred, with automatic end-to-end encrypted server relay fallback.",
      inviteFromThisComputer: "Invite from this computer",
      inviteFromThisComputerDesc: "Generate and copy a one-time connection code; computer pairing does not use QR codes.",
      createConnectionCode: "Create connection code",
      oneTimeConnectionCode: "One-time connection code",
      copyCode: "Copy code",
      waitingForOtherComputer: "Waiting for the other computer to submit…",
      regenerate: "Regenerate",
      joinAnotherComputer: "Join another computer",
      joinAnotherComputerDesc: "Paste the one-time connection code created on the other computer.",
      pasteConnectionCodeHere: "Paste connection code here",
      claimInvitation: "Claim invitation",
      waitingForApprovalThenAuto: "Waiting for approval, then pairing will finish automatically…",
      allowThisComputerTitle: "Allow this computer to connect?",
      approvalDescription: (label) => `${label} submitted the one-time connection code. Verify its fingerprint before deciding.`,
      deviceLabel: "Device",
      deviceFingerprintLabel: "Device fingerprint",
      requestedAccessLabel: "Requested access",
      requestedAccessDesc: "Remote Agent chat, project list, and compute jobs",
      decline: "Decline",
      workingEllipsis: "Working…",
      allowConnection: "Allow connection",
      pairedComputeNodesTitle: "Paired compute nodes",
      computersCount: (count) => `${count} computers`,
      noOtherComputersPaired: "No other computers paired yet.",
      canRemoteJobsAndChat: "Remote jobs and Agent chat enabled",
      computeJobsOnly: "Compute jobs only",
      nodeColumnHeader: "Node",
      statusColumnHeader: "Status",
      systemColumnHeader: "System",
      lastOnlineColumnHeader: "Last online",
      actionColumnHeader: "Action",
      online: "Online",
      offline: "Offline",
      connectingAriaLabel: (name) => `Connecting ${name}`,
      revokingAriaLabel: (name) => `Revoking ${name}`,
      moreActionsAriaLabel: (name) => `More actions for ${name}`,
      connect: "Connect",
      connectKeychainHint: "Connection may request system keychain access",
      revokePairing: "Revoke pairing",
      revokePairingHint: "Pair again to reconnect this computer",
    },
    memoryExplorer: {
      layerNames: {
        l0: "Authoritative sessions",
        l1: "Research atoms",
        l2: "Research episodes",
        l3: "Research constitution",
      },
      editMemoryContentAriaLabel: "Edit memory content",
      collapseFull: "Collapse",
      expandFull: "Show full entry",
      contextLabel: "Context",
      artifactsLabel: "Artifacts",
      sourceEventsLabel: "Source events",
      knowledgeUpdateLabel: "Knowledge update",
      supersedes: "Supersedes",
      sourceSessionLabel: "Source session",
      noSourceSessionRecorded: "No source session recorded",
      saveCorrection: "Save correction",
      cancel: "Cancel",
      edit: "Edit",
      delete: "Delete",
      deleteConfirm: "Delete this derived memory? The authoritative SomniQ Session remains intact.",
      title: "Research memory library",
      subtitle: "Inspect the project's R0 authoritative sessions, R1 atoms, R2 episodes, and R3 constitution with provenance.",
      loadingEllipsis: "Loading…",
      refreshLibrary: "Refresh library",
      memoryLayersAriaLabel: "Memory layers",
      searchPlaceholder: "Search facts, conclusions, or conversations",
      clear: "Clear",
      search: "Search",
      somePartialUnavailable: "Some layers are unavailable",
      searchResults: "Search results",
      resultsCount: (count) => `${count} results`,
      noMatchingMemories: "No matching memories found.",
      layerEmptyContent: "This layer does not have any content yet.",
      researchEpisodesAriaLabel: "Research episodes",
      untitledEpisode: "Untitled episode",
      noResearchEpisodesYet: "No research episodes yet.",
      episodeEmpty: "This episode is empty.",
      selectEpisodeToInspect: "Select a research episode to inspect its content.",
      readOnlyConsolidatedFooter: "Read only · consolidated from R1 atoms; correct the underlying R1 entry instead",
      coreProfile: "Core profile",
      derivedFromTracedFooter: "Derived from traced R1 atoms; Project Goal, Workflow, and evidence remain separate authorities.",
      coreProfileNotGenerated: "The core profile has not been generated yet. It updates after more conversations.",
      loadedLabel: "Loaded",
      entriesPerLayerNote: (limit) => `showing the newest ${limit} entries per layer; search for older content`,
    },
    memoryRecallPreview: {
      layerLabel: {
        R3: "Project profile",
        R1: "Research atoms",
        R2: "Research episodes",
        R0: "Authoritative sessions",
      },
      reasonLabel: {
        duplicate: "Duplicate",
        budget: "Over quota",
        not_standing: "Not standing",
      },
      matchLabel: "match",
      title: "Recall preview",
      subtitle: "See what this turn would inject and what it drops. No turn is sent.",
      queryPlaceholder: "e.g. what was the p95 last time",
      queryAriaLabel: "Recall preview query",
      assembling: "Assembling…",
      previewRecall: "Preview recall",
      charsInjected: "chars",
      budgetAllocationAriaLabel: "Budget allocation",
      injectionLayersTitle: "Injection layers",
      injectionLayersSubtitle: "Characters used / budget · injected / candidates",
      charsUnit: "chars",
      injectedCountLabel: (kept, candidates) => `${kept} / ${candidates} injected`,
      sharedRemainingBudget: "Shared remaining budget",
      nothingRecalled: "Nothing recalled; no memory section would be injected.",
      injected: "Injected",
      dropped: "Dropped",
      nothingDropped: "Nothing dropped.",
      hide: "Hide",
      raw: "Raw",
    },
    memory: {
      requeuedTasks: (restored) => `Requeued ${restored} memory ${restored === 1 ? "task" : "tasks"}`,
      exportedTo: (path) => `Exported to ${path}`,
      unavailable: "unavailable",
      loadingStatus: "loading",
      researchMemoryTitle: "SomniQ Research Memory",
      pending: "Pending",
      refresh: "Refresh",
      tasksNeedingAttention: (count) => `Memory tasks needing attention (${count})`,
      deadLetterSubtitle: "These memory tasks exhausted their retries; their source sessions remain intact. Requeuing resets the attempt count and runs them again now.",
      requeuingEllipsis: "Requeuing…",
      requeue: "Requeue",
      attemptsLabel: "attempts",
      rederiveTitle: "Re-derive memories",
      rederiveSubtitle:
        "R1 is derived once when a conversation ends and never revisited, so an improvement to the extraction rules does not reach memories you already have. This replays every stored conversation with the current rules; originals are untouched, and your corrections and deletions are kept.",
      rederiveStaleAtoms: (count) =>
        `${count} ${count === 1 ? "memory came" : "memories came"} from an older rule set`,
      rederiveConfirm:
        "Re-derive R1–R3 with the current extraction rules? Original conversations are untouched, and memories you confirmed or deleted are kept.",
      rederiveButton: "Re-derive R1–R3",
      rederivingEllipsis: "Replaying…",
      rederiveSummary: (replayed, written, preserved) =>
        `Replayed ${replayed} turns · rebuilt ${written} memories · kept ${preserved} human-confirmed`,
      backfillHistoryTitle: "Backfill history",
      backfillSubtitle: "Backfills R1–R3 from ordinary authoritative Sessions; Workflow Sessions are excluded and original chats remain unchanged.",
      previewButton: "Preview",
      cancel: "Cancel",
      exportMemory: "Export memory",
      previewSummaryLabel: "Preview",
      alreadyBackfilled: "already backfilled",
      completedLabel: "Completed",
      cancelledLabel: "cancelled",
    },
    nav: {
      labels: {
        profile: "Profile",
        general: "General",
        account: "Account & usage",
        models: "Model service",
        memory: "Smart memory",
        mail: "Mail",
        remote: "Remote control",
        extensions: "Plugins",
        environment: "Environment",
        about: "About",
      },
      groupLabels: { personal: "Personal", integration: "Models & integration", system: "System" },
      misc: { back: "Back to app" },
    },
  },
};
