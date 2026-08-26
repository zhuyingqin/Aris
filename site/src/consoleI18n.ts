import type { Lang } from "./i18n";

export interface ConsoleCopy {
  docTitle: string;
  header: {
    returnHome: string;
    returnHomeTitle: string;
    consoleBadge: string;
    logout: string;
  };
  nav: {
    analyticsTitle: string;
    activityFull: string;
    activityShort: string;
    activityTitle: string;
    usageFull: string;
    usageShort: string;
    usageTitle: string;
    terminalsTitle: string;
    remoteFull: string;
    remoteShort: string;
    remoteTitle: string;
    onlineCount: (count: number) => string;
    accountTitle: string;
    planFull: string;
    planShort: string;
    planTitle: string;
    resourcesTitle: string;
    desktopFull: string;
    desktopShort: string;
    desktopTitle: string;
    miniQuotaLabel: string;
    miniQuotaRefresh: string;
  };
  remote: {
    eyebrow: string;
    greeting: string;
    kicker: string;
    connectTitle: string;
    refreshBtn: string;
    refreshingBtn: string;
    refreshTitle: string;
    noticeTitle: string;
    unrecognizedCodeTitle: string;
    pairingCompleteTitle: string;
    signInBtn: string;
    retryBtn: string;
    dismissBtn: string;
    invalidCodeReason: string;
    errSignedOut: string;
    errExpired: string;
    errGateway: string;
    pairingSuccessNotice: (name: string) => string;
    desktopOnlineReady: string;
    desktopOnlineDesc: string;
    openChatBtn: string;
    openNewTab: string;
    otherPairedComputers: string;
    accountClientsAria: string;
    statusOnlineClick: string;
    statusOffline: string;
    pairAnotherBtn: string;
    noOnlineComputerTitle: string;
    noOnlineComputerDesc: string;
    step1Title: string;
    step1Sub: string;
    step2Title: string;
    step2Sub: string;
    manualTitleWithDevice: string;
    manualTitleNoDevice: string;
    manualDesc: string;
    cancelBtn: string;
    inputPlaceholder: string;
    startPairingBtn: string;
    pairingActiveConnecting: string;
    pairingActiveApproveOnDesktop: string;
    cancelPairingBtn: string;
    zeroTrustTitle: string;
    zeroTrustDesc: string;
    mobileKicker: string;
    mobileTitle: string;
    mobileQrTip: string;
    copyLinkBtn: string;
    copiedBtn: string;
    openInNewTabBtn: string;
    e2eEncrypted: string;
    switchDeviceBtn: string;
    openInNewWindowBtn: string;
    iframeTitle: string;
    noClientAvailable: string;
    backToClientsBtn: string;
  };
  activity: {
    greetingSub: (days: number) => string;
    tagReviewer: string;
    tagMemory: string;
    tagGroup: (g: string) => string;
    tagResearchTier: string;
    tagTotalCalls: (n: string) => string;
    balanceKicker: string;
    refreshBalance: string;
    syncing: string;
    usedQuota: (s: string) => string;
    cumulativeUsageKicker: string;
    cumulativeUsageDesc: (n: string) => string;
    dailyCallsTitle: string;
    dailyCallsPeak: (n: number) => string;
    noData: string;
    daysAgo30: string;
    today: string;
    noCallHistoryYet: string;
    activeDaysTitle: string;
    activeDaysTooltip: (days: number) => string;
    legendLess: string;
    legendMore: string;
    legendCalls0: string;
    legendCalls1: string;
    legendCalls2: string;
    legendCalls3: string;
    legendCalls4: string;
    months: string[];
    heatmapCellCalls: (date: string, calls: string) => string;
    heatmapCellZero: (date: string) => string;
    synthesesLabel: string;
    reviewsLabel: string;
    topPartnerKicker: string;
    topPartnerCooperated: (n: string) => string;
    noCallsYet: string;
    secondPartnerKicker: string;
    secondPartnerInvocations: (n: string) => string;
    noSecondModelYet: string;
  };
  usage: {
    heroTitle: string;
    heroSubtitle: string;
    tagTotal: (n: string) => string;
    tagConsumed: (s: string) => string;
    tagBalance: (s: string) => string;
    statAvailable: string;
    statConsumed: string;
    statTotalRequests: string;
    statTotalRequestsSub: string;
    statActiveModels: string;
    statActiveModelsSub: string;
    trendTitle: string;
    breakdownTitle: string;
    refreshLogsBtn: string;
    dateRangeAria: string;
    rangeAll: string;
    range30d: string;
    range7d: string;
    range24h: string;
    metricToggleAria: string;
    metricCalls: string;
    metricQuota: string;
    donutTotalCalls: string;
    donutTotalQuota: string;
    callsUnit: string;
    noBreakdownRecords: string;
    recentLogsTitle: string;
    badgeMonth: string;
    filterModelAria: string;
    allModelsOption: string;
    pageSizeAria: string;
    pageSizeOption: (n: number) => string;
    colTime: string;
    colModel: string;
    colPrompt: string;
    colCompletion: string;
    colQuota: string;
    colLatency: string;
    loadingMonthLogs: string;
    noMatchingLogs: string;
    paginationInfo: (cur: number, total: number, count: string) => string;
    prevPage: string;
    nextPage: string;
  };
  plan: {
    heroTitle: string;
    subgreetingActive: string;
    subgreetingUnsubscribed: string;
    tagActivePro: string;
    tagCurrentFree: string;
    tagClusterGroup: (g: string) => string;
    tagDefaultGroup: string;
    tagBalance: (b: string) => string;
    activeMemberPro: string;
    activeSomniqPro: string;
    statusActiveRunning: string;
    poweredByDesc: string;
    clusterGroupLabel: string;
    defaultGroupName: string;
    detailAvailableQuota: string;
    detailUsedQuota: string;
    detailTotalRequests: string;
    callsUnit: string;
    detailWorkflowsSub: string;
    progressTitle: string;
    remainingPercent: (pct: string) => string;
    freeTierName: string;
    freeTierDesc: string;
    freeTierPrice: string;
    freeTierPeriod: string;
    freeTierF1: string;
    freeTierF2: string;
    freeTierF3: string;
    currentDefaultBtn: string;
    popularBadge: string;
    proTierName: string;
    proTierDesc: string;
    proTierPrice: string;
    proTierPeriod: string;
    proTierF1: string;
    proTierF2: string;
    proTierF3: string;
    proTierF4: string;
    proTierF5: string;
    subscribeNowBtn: string;
    teamTierName: string;
    teamTierDesc: string;
    teamTierPrice: string;
    teamTierPeriod: string;
    teamTierF1: string;
    teamTierF2: string;
    teamTierF3: string;
    teamTierF4: string;
    contactTeamBtn: string;
  };
}

export const consoleZh: ConsoleCopy = {
  docTitle: "SomniQ Studio 控制台 — 科研算力与用量概览",
  header: {
    returnHome: "返回官网",
    returnHomeTitle: "返回官网首页",
    consoleBadge: "控制台",
    logout: "退出登录",
  },
  nav: {
    analyticsTitle: "科研分析",
    activityFull: "活跃看板",
    activityShort: "看板",
    activityTitle: "活跃看板",
    usageFull: "算力用量",
    usageShort: "用量",
    usageTitle: "算力用量",
    terminalsTitle: "协同终端",
    remoteFull: "远程工作台",
    remoteShort: "工作台",
    remoteTitle: "远程工作台",
    onlineCount: (count: number) => `${count} 在线`,
    accountTitle: "算力与账户",
    planFull: "套餐与订阅",
    planShort: "套餐",
    planTitle: "套餐与订阅",
    resourcesTitle: "资源生态",
    desktopFull: "下载桌面端",
    desktopShort: "下载",
    desktopTitle: "下载桌面客户端安装包",
    miniQuotaLabel: "可用科研算力",
    miniQuotaRefresh: "刷新额度",
  },
  remote: {
    eyebrow: "REMOTE ACCESS · 同账号客户端",
    greeting: "连接你的 SomniQ 客户端",
    kicker: "远程访问",
    connectTitle: "连接电脑客户端",
    refreshBtn: "刷新",
    refreshingBtn: "刷新中...",
    refreshTitle: "刷新客户端列表",
    noticeTitle: "连接提示",
    unrecognizedCodeTitle: "连接码无法识别",
    pairingCompleteTitle: "绑定成功",
    signInBtn: "重新登录",
    retryBtn: "重试",
    dismissBtn: "知道了",
    invalidCodeReason: "无法识别这个连接码。",
    errSignedOut: "当前浏览器没有可授权给远程网关的登录状态。请重新登录后再试。",
    errExpired: "登录状态已失效，无法读取同账号客户端。请重新登录后再试。",
    errGateway: "暂时无法读取同账号客户端，可稍后重试。",
    pairingSuccessNotice: (name: string) => `🎉 绑定成功！「${name}」已上线，可立即开始对话。`,
    desktopOnlineReady: "🟢 电脑在线 · 已就绪",
    desktopOnlineDesc: "向这台电脑发起端到端加密连接，在电脑端弹窗授权后直接进入 Chat 对话工作台。",
    openChatBtn: "进入 Chat 对话",
    openNewTab: "新标签页打开",
    otherPairedComputers: "切换其他已绑定的电脑",
    accountClientsAria: "账号客户端",
    statusOnlineClick: "在线 · 点击连接",
    statusOffline: "离线",
    pairAnotherBtn: "+ 绑定另一台电脑客户端",
    noOnlineComputerTitle: "尚未检测到在线的电脑客户端",
    noOnlineComputerDesc: "请确保已在电脑上启动 SomniQ Studio 并保持登录；客户端在线后将自动出现在此处，可一键发起安全连接。",
    step1Title: "启动电脑客户端",
    step1Sub: "打开 SomniQ Studio",
    step2Title: "网页自动就绪",
    step2Sub: "点击直连进入对话",
    manualTitleWithDevice: "绑定新的电脑客户端",
    manualTitleNoDevice: "手动绑定电脑客户端（输入连接码）",
    manualDesc: "在电脑端 SomniQ Studio「设置 → 远程访问」复制连接码粘贴在下方：",
    cancelBtn: "返回在线电脑",
    inputPlaceholder: "在此粘贴电脑复制的连接码...",
    startPairingBtn: "发起安全绑定",
    pairingActiveConnecting: "正在与电脑建立加密握手...",
    pairingActiveApproveOnDesktop: "请在电脑端点击【允许配对】",
    cancelPairingBtn: "取消本次绑定",
    zeroTrustTitle: "严格的零信任授权机制",
    zeroTrustDesc: "每次连接或配对都必须经由电脑端本机弹窗显式确认。",
    mobileKicker: "手机 / 平板协同",
    mobileTitle: "扫码用手机继续研究",
    mobileQrTip: "支持 iOS / Android 原生相机扫码",
    copyLinkBtn: "复制链接",
    copiedBtn: "已复制",
    openInNewTabBtn: "新窗口打开",
    e2eEncrypted: "端到端加密",
    switchDeviceBtn: "切换电脑设备",
    openInNewWindowBtn: "新窗口打开",
    iframeTitle: "SomniQ 远程工作台",
    noClientAvailable: "没有可连接的客户端",
    backToClientsBtn: "返回客户端列表",
  },
  activity: {
    greetingSub: (days: number) => `这是您使用 SomniQ Studio 进行自主科研的第 ${days} 天。`,
    tagReviewer: "独立审查验证",
    tagMemory: "三层结构化记忆",
    tagGroup: (g: string) => `分组: ${g}`,
    tagResearchTier: "千研",
    tagTotalCalls: (n: string) => `累计调用: ${n}`,
    balanceKicker: "当前可用科研算力",
    refreshBalance: "刷新余额",
    syncing: "同步中...",
    usedQuota: (s: string) => `已消耗算力: ${s}`,
    cumulativeUsageKicker: "累计科研消耗",
    cumulativeUsageDesc: (n: string) => `已累计完成 ${n} 次科研模型交互，涵盖文献检索、实验运行、论文撰写与独立审查。`,
    dailyCallsTitle: "近 30 天每日调用次数",
    dailyCallsPeak: (n: number) => `峰值: ${n} 次/天`,
    noData: "暂无数据",
    daysAgo30: "30天前",
    today: "今天",
    noCallHistoryYet: "暂无历史调用记录，开始使用后将显示趋势",
    activeDaysTitle: "SomniQ 科研活跃天数",
    activeDaysTooltip: (days: number) => `记录从注册日至今的 ${days} 天科研活跃轨迹`,
    legendLess: "少",
    legendMore: "多",
    legendCalls0: "0 次调用",
    legendCalls1: "1 - 40 次调用",
    legendCalls2: "41 - 150 次调用",
    legendCalls3: "151 - 400 次调用",
    legendCalls4: "400+ 次调用",
    months: ["8月", "9月", "10月", "11月", "12月", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月"],
    heatmapCellCalls: (date: string, calls: string) => `${date}：${calls} 次调用`,
    heatmapCellZero: (date: string) => `${date}：0 次调用`,
    synthesesLabel: "文献提炼与综述输出",
    reviewsLabel: "独立审查与置信度审计",
    topPartnerKicker: "主要执行 AI 伙伴",
    topPartnerCooperated: (n: string) => `最近深度协作 ${n} 次`,
    noCallsYet: "暂无调用记录",
    secondPartnerKicker: "高阶推理与审查偏好",
    secondPartnerInvocations: (n: string) => `调用执行 ${n} 次`,
    noSecondModelYet: "暂无第二模型记录",
  },
  usage: {
    heroTitle: "科研算力用量分析",
    heroSubtitle: "实时统计您在 SomniQ Studio 各大科研大模型的调用频次、词元消耗与响应日志。",
    tagTotal: (n: string) => `累计请求: ${n}`,
    tagConsumed: (s: string) => `已消耗: ${s}`,
    tagBalance: (s: string) => `余额: ${s}`,
    statAvailable: "当前可用额度",
    statConsumed: "累计消耗算力",
    statTotalRequests: "科研请求总数",
    statTotalRequestsSub: "涵盖所有交互流程",
    statActiveModels: "活跃科研模型",
    statActiveModelsSub: "主力驱动架构",
    trendTitle: "近 30 天每日调用趋势",
    breakdownTitle: "各模型调用分布与消耗明细",
    refreshLogsBtn: "刷新明细",
    dateRangeAria: "日期范围",
    rangeAll: "全部时间",
    range30d: "近 30 天",
    range7d: "近 7 天",
    range24h: "近 24 小时",
    metricToggleAria: "指标切换",
    metricCalls: "按调用频次",
    metricQuota: "按算力消耗",
    donutTotalCalls: "总调用次数",
    donutTotalQuota: "总消耗算力",
    callsUnit: "次",
    noBreakdownRecords: "所选时间段内暂无模型调用记录",
    recentLogsTitle: "最新科研调用实时明细",
    badgeMonth: "近 1 个月",
    filterModelAria: "按模型筛选",
    allModelsOption: "全部模型",
    pageSizeAria: "每页条数",
    pageSizeOption: (n: number) => `${n} 条/页`,
    colTime: "时间",
    colModel: "模型",
    colPrompt: "输入词元",
    colCompletion: "产出词元",
    colQuota: "消耗算力",
    colLatency: "耗时",
    loadingMonthLogs: "正在加载近 1 个月调用明细...",
    noMatchingLogs: "近 1 个月暂无符合条件的调用记录",
    paginationInfo: (cur: number, total: number, count: string) =>
      `第 ${cur} / ${total} 页 · 近 1 个月共 ${count} 条记录`,
    prevPage: "← 上一页",
    nextPage: "下一页 →",
  },
  plan: {
    heroTitle: "套餐与科研订阅管理",
    subgreetingActive: "管理您在 SomniQ new-api 平台当前绑定的科研算力套餐、专属集群权限与履约明细。",
    subgreetingUnsubscribed: "选择适合您或实验室团队的 AI 科研自主工作流算力套餐，即刻开启全自动科研。",
    tagActivePro: "当前订阅: 千研 Pro 会员",
    tagCurrentFree: "当前计划: 社区版",
    tagClusterGroup: (g: string) => `集群分组: ${g}`,
    tagDefaultGroup: "默认分组",
    tagBalance: (b: string) => `可用额度: ${b}`,
    activeMemberPro: "千研科研 Pro 专业版会员",
    activeSomniqPro: "SomniQ 科研专业版",
    statusActiveRunning: "● 活跃履约中",
    poweredByDesc: "基于 SomniQ new-api 高性能科研大模型网关与千研集群",
    clusterGroupLabel: "所属集群分组",
    defaultGroupName: "千研",
    detailAvailableQuota: "可用科研算力",
    detailUsedQuota: "累计消耗算力",
    detailTotalRequests: "累计调用请求",
    callsUnit: "次",
    detailWorkflowsSub: "涵盖全流程科研",
    progressTitle: "算力额度消耗进度",
    remainingPercent: (pct: string) => `${pct}% 剩余`,
    freeTierName: "社区体验版",
    freeTierDesc: "适合个人轻量学术探索与体验",
    freeTierPrice: "¥0",
    freeTierPeriod: "/ 永久",
    freeTierF1: "基础科研对话",
    freeTierF2: "免费基础模型（DeepSeek Flash Free 等）",
    freeTierF3: "本地工作区存储",
    currentDefaultBtn: "当前默认",
    popularBadge: "最受欢迎 · 千研推荐",
    proTierName: "千研科研 Pro 专业版",
    proTierDesc: "为研究生、学者与独立研究者打造的全功能自主科研算力",
    proTierPrice: "¥199",
    proTierPeriod: "/ 月",
    proTierF1: "包含 50,000,000 科研词元",
    proTierF2: "独立 Reviewer 独立审查审计回路",
    proTierF3: "7 大顶尖科研大模型全量解锁",
    proTierF4: "三层结构化论文记忆系统",
    proTierF5: "手机端端对端加密远程工作台",
    subscribeNowBtn: "立即订阅升级",
    teamTierName: "实验室与高校团队版",
    teamTierDesc: "课题组、高校实验室与企业科研团队多人共享与私有化部署",
    teamTierPrice: "¥999",
    teamTierPeriod: "/ 月",
    teamTierF1: "包含 300,000,000 科研词元",
    teamTierF2: "课题组多人文献库与共享算力池",
    teamTierF3: "支持本地局域网 / 私有云部署",
    teamTierF4: "专属科研技术顾问支持",
    contactTeamBtn: "联系课题组定制",
  },
};

export const consoleEn: ConsoleCopy = {
  docTitle: "SomniQ Studio Console — AI Compute & Usage Overview",
  header: {
    returnHome: "Home",
    returnHomeTitle: "Return to Home",
    consoleBadge: "Console",
    logout: "Log out",
  },
  nav: {
    analyticsTitle: "Analytics",
    activityFull: "Activity",
    activityShort: "Activity",
    activityTitle: "Activity & Analytics",
    usageFull: "Usage",
    usageShort: "Usage",
    usageTitle: "Compute Usage",
    terminalsTitle: "Terminals",
    remoteFull: "Remote Workspace",
    remoteShort: "Remote",
    remoteTitle: "Remote Workspace",
    onlineCount: (count: number) => `${count} online`,
    accountTitle: "Account",
    planFull: "Plans & Billing",
    planShort: "Plans",
    planTitle: "Plans & Billing",
    resourcesTitle: "Resources",
    desktopFull: "Desktop App",
    desktopShort: "Download",
    desktopTitle: "Download Desktop Client",
    miniQuotaLabel: "Available Quota",
    miniQuotaRefresh: "Refresh Quota",
  },
  remote: {
    eyebrow: "REMOTE ACCESS · ACCOUNT CLIENTS",
    greeting: "Connect your SomniQ client",
    kicker: "REMOTE ACCESS",
    connectTitle: "Connect Desktop Client",
    refreshBtn: "Refresh",
    refreshingBtn: "Refreshing...",
    refreshTitle: "Refresh clients",
    noticeTitle: "Connection Notice",
    unrecognizedCodeTitle: "Unrecognized code",
    pairingCompleteTitle: "Pairing Complete",
    signInBtn: "Sign In",
    retryBtn: "Retry",
    dismissBtn: "Dismiss",
    invalidCodeReason: "This is not a SomniQ connection code. Copy it again from Settings → Remote Access on the computer.",
    errSignedOut: "This browser holds no sign-in the gateway can use. Sign in again.",
    errExpired: "Your session was rejected. Sign in again to load account clients.",
    errGateway: "Could not reach the gateway. Try again shortly.",
    pairingSuccessNotice: (name: string) => `🎉 Paired. “${name}” is online and ready.`,
    desktopOnlineReady: "🟢 Desktop Online · Ready",
    desktopOnlineDesc: "Request an E2E encrypted connection. Chat opens directly after desktop approval.",
    openChatBtn: "Open Chat",
    openNewTab: "New Tab",
    otherPairedComputers: "OTHER PAIRED COMPUTERS",
    accountClientsAria: "Account clients",
    statusOnlineClick: "Online · Click to Connect",
    statusOffline: "Offline",
    pairAnotherBtn: "+ Pair Another Computer",
    noOnlineComputerTitle: "No Online Computer Detected",
    noOnlineComputerDesc: "Make sure SomniQ Studio is running on your computer. It will appear here automatically when online.",
    step1Title: "Start Desktop App",
    step1Sub: "Launch SomniQ",
    step2Title: "Auto Discovery",
    step2Sub: "Click to connect",
    manualTitleWithDevice: "Pair a New Computer",
    manualTitleNoDevice: "Manual Pairing with Code",
    manualDesc: "Copy the connection code in SomniQ Desktop settings and paste below:",
    cancelBtn: "Cancel",
    inputPlaceholder: "Paste connection code here...",
    startPairingBtn: "Start Pairing",
    pairingActiveConnecting: "Connecting to computer...",
    pairingActiveApproveOnDesktop: "Please click 'Approve' on desktop",
    cancelPairingBtn: "Cancel Pairing",
    zeroTrustTitle: "Zero-trust client authorization",
    zeroTrustDesc: "Every connection must be explicitly confirmed on your desktop.",
    mobileKicker: "MOBILE & TABLET",
    mobileTitle: "Scan for mobile companion",
    mobileQrTip: "Supports iOS & Android camera",
    copyLinkBtn: "Copy link",
    copiedBtn: "Copied",
    openInNewTabBtn: "Open in new tab",
    e2eEncrypted: "E2E Encrypted",
    switchDeviceBtn: "Switch Device",
    openInNewWindowBtn: "Open in new window",
    iframeTitle: "SomniQ Remote Workspace",
    noClientAvailable: "No client is available",
    backToClientsBtn: "Back to clients",
  },
  activity: {
    greetingSub: (days: number) => `This is your day ${days} of using SomniQ Studio.`,
    tagReviewer: "Independent Reviewer",
    tagMemory: "Project Memory",
    tagGroup: (g: string) => `Group: ${g}`,
    tagResearchTier: "Research Tier",
    tagTotalCalls: (n: string) => `Total Calls: ${n}`,
    balanceKicker: "AVAILABLE AI COMPUTE",
    refreshBalance: "Refresh",
    syncing: "Syncing...",
    usedQuota: (s: string) => `Used Quota: ${s}`,
    cumulativeUsageKicker: "CUMULATIVE RESEARCH USAGE",
    cumulativeUsageDesc: (n: string) => `Completed ${n} research model interactions, covering literature search, experiments, drafting, and review.`,
    dailyCallsTitle: "Daily Calls — Last 30 Days",
    dailyCallsPeak: (n: number) => `Peak: ${n}/day`,
    noData: "No data",
    daysAgo30: "30d ago",
    today: "Today",
    noCallHistoryYet: "No call history yet. Trend will appear after first usage.",
    activeDaysTitle: "SomniQ Active Days",
    activeDaysTooltip: (days: number) => `Activity recorded across ${days} active days`,
    legendLess: "Less",
    legendMore: "More",
    legendCalls0: "0 calls",
    legendCalls1: "1 - 40 calls",
    legendCalls2: "41 - 150 calls",
    legendCalls3: "151 - 400 calls",
    legendCalls4: "400+ calls",
    months: ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"],
    heatmapCellCalls: (date: string, calls: string) => `${date}: ${calls} calls`,
    heatmapCellZero: (date: string) => `${date}: 0 calls`,
    synthesesLabel: "Literature Syntheses",
    reviewsLabel: "Independent Review Passes",
    topPartnerKicker: "Most Frequent AI Partner",
    topPartnerCooperated: (n: string) => `Recently cooperated ${n} times`,
    noCallsYet: "No records yet",
    secondPartnerKicker: "Recent Model Preference",
    secondPartnerInvocations: (n: string) => `Invocations ${n} times`,
    noSecondModelYet: "No secondary model yet",
  },
  usage: {
    heroTitle: "AI Compute & Usage Analytics",
    heroSubtitle: "Real-time usage statistics across all LLM models, token consumption, and response logs.",
    tagTotal: (n: string) => `Total: ${n}`,
    tagConsumed: (s: string) => `Consumed: ${s}`,
    tagBalance: (s: string) => `Balance: ${s}`,
    statAvailable: "AVAILABLE QUOTA",
    statConsumed: "TOTAL CONSUMED",
    statTotalRequests: "TOTAL REQUESTS",
    statTotalRequestsSub: "Across all workflows",
    statActiveModels: "ACTIVE MODELS",
    statActiveModelsSub: "Core engines",
    trendTitle: "Daily Call Trend (Last 30 Days)",
    breakdownTitle: "Model Usage Breakdown",
    refreshLogsBtn: "Refresh",
    dateRangeAria: "Date Range",
    rangeAll: "All Time",
    range30d: "Last 30 Days",
    range7d: "Last 7 Days",
    range24h: "Last 24h",
    metricToggleAria: "Metric Switch",
    metricCalls: "By Calls",
    metricQuota: "By Quota",
    donutTotalCalls: "Total Calls",
    donutTotalQuota: "Total Quota",
    callsUnit: "calls",
    noBreakdownRecords: "No model usage records found for selected period.",
    recentLogsTitle: "Recent Invocations Log",
    badgeMonth: "Last 30 Days",
    filterModelAria: "Filter by model",
    allModelsOption: "All Models",
    pageSizeAria: "Page size",
    pageSizeOption: (n: number) => `${n} / page`,
    colTime: "Time",
    colModel: "Model",
    colPrompt: "Prompt",
    colCompletion: "Completion",
    colQuota: "Quota",
    colLatency: "Latency",
    loadingMonthLogs: "Loading records from the last month...",
    noMatchingLogs: "No invocation logs found for the selected filter",
    paginationInfo: (cur: number, total: number, count: string) =>
      `Page ${cur} of ${total} · Total ${count} records in last 30d`,
    prevPage: "← Prev",
    nextPage: "Next →",
  },
  plan: {
    heroTitle: "Plan & Subscription Management",
    subgreetingActive: "Manage your active AI research subscription, cluster group, and quota on SomniQ new-api.",
    subgreetingUnsubscribed: "Choose the best research AI compute subscription for yourself or your laboratory.",
    tagActivePro: "Active: Thousand Research Pro",
    tagCurrentFree: "Current: Free Tier",
    tagClusterGroup: (g: string) => `Group: ${g}`,
    tagDefaultGroup: "Default",
    tagBalance: (b: string) => `Balance: ${b}`,
    activeMemberPro: "Thousand Research Pro Member",
    activeSomniqPro: "SomniQ Pro Tier",
    statusActiveRunning: "● Active & Running",
    poweredByDesc: "Powered by SomniQ new-api LLM gateway and Thousand Research cluster",
    clusterGroupLabel: "Cluster Group",
    defaultGroupName: "Research",
    detailAvailableQuota: "Available Quota",
    detailUsedQuota: "Used Quota",
    detailTotalRequests: "Total Requests",
    callsUnit: "calls",
    detailWorkflowsSub: "All workflows",
    progressTitle: "Quota Consumption Progress",
    remainingPercent: (pct: string) => `${pct}% remaining`,
    freeTierName: "Free Tier",
    freeTierDesc: "For personal casual research exploration",
    freeTierPrice: "¥0",
    freeTierPeriod: "/ forever",
    freeTierF1: "Basic research chat",
    freeTierF2: "Free base models",
    freeTierF3: "Local workspace storage",
    currentDefaultBtn: "Current Default",
    popularBadge: "POPULAR · RECOMMENDED",
    proTierName: "Thousand Research Pro",
    proTierDesc: "Full-featured autonomous research compute for researchers",
    proTierPrice: "¥199",
    proTierPeriod: "/ month",
    proTierF1: "Includes 50M research Tokens",
    proTierF2: "16-Step Independent Reviewer Loop",
    proTierF3: "All 7 top LLMs unlocked",
    proTierF4: "3-tier structured memory",
    proTierF5: "E2EE Secured remote mobile PWA",
    subscribeNowBtn: "Subscribe Now",
    teamTierName: "Lab & Team Tier",
    teamTierDesc: "For research labs and institutional teams",
    teamTierPrice: "¥999",
    teamTierPeriod: "/ month",
    teamTierF1: "Includes 300M research Tokens",
    teamTierF2: "Shared lab compute & literature pool",
    teamTierF3: "Private cloud / LAN deployment",
    teamTierF4: "Dedicated technical support",
    contactTeamBtn: "Contact Team",
  },
};

export const consoleEs: ConsoleCopy = {
  docTitle: "Consola de SomniQ Studio — Resumen de Cómputo y Uso de IA",
  header: {
    returnHome: "Inicio",
    returnHomeTitle: "Volver a la página de inicio",
    consoleBadge: "Consola",
    logout: "Cerrar sesión",
  },
  nav: {
    analyticsTitle: "Analítica",
    activityFull: "Panel de Actividad",
    activityShort: "Actividad",
    activityTitle: "Panel de Actividad y Analítica",
    usageFull: "Uso de Cómputo",
    usageShort: "Uso",
    usageTitle: "Uso de Cómputo",
    terminalsTitle: "Terminales",
    remoteFull: "Espacio Remoto",
    remoteShort: "Remoto",
    remoteTitle: "Espacio de Trabajo Remoto",
    onlineCount: (count: number) => `${count} en línea`,
    accountTitle: "Cuenta y Cómputo",
    planFull: "Planes y Suscripción",
    planShort: "Planes",
    planTitle: "Planes y Facturación",
    resourcesTitle: "Recursos",
    desktopFull: "App de Escritorio",
    desktopShort: "Descargar",
    desktopTitle: "Descargar instalador de cliente de escritorio",
    miniQuotaLabel: "Cómputo Disponible",
    miniQuotaRefresh: "Actualizar Cuota",
  },
  remote: {
    eyebrow: "ACCESO REMOTO · CLIENTES DE LA CUENTA",
    greeting: "Conecta tu cliente SomniQ",
    kicker: "ACCESO REMOTO",
    connectTitle: "Conectar Cliente de Escritorio",
    refreshBtn: "Actualizar",
    refreshingBtn: "Actualizando...",
    refreshTitle: "Actualizar lista de clientes",
    noticeTitle: "Aviso de Conexión",
    unrecognizedCodeTitle: "Código no reconocido",
    pairingCompleteTitle: "Emparejamiento Completado",
    signInBtn: "Iniciar Sesión",
    retryBtn: "Reintentar",
    dismissBtn: "Entendido",
    invalidCodeReason: "Este no es un código de conexión de SomniQ válido. Cópialo nuevamente desde Configuración → Acceso Remoto en tu equipo.",
    errSignedOut: "Este navegador no tiene una sesión activa para autorizar en la pasarela remota. Inicia sesión nuevamente.",
    errExpired: "Tu sesión ha expirado y no se pueden cargar los clientes asociados. Inicia sesión nuevamente.",
    errGateway: "No se pudo conectar con la pasarela remota. Inténtalo de nuevo en unos momentos.",
    pairingSuccessNotice: (name: string) => `🎉 ¡Vinculación exitosa! “${name}” está en línea y listo para conversar.`,
    desktopOnlineReady: "🟢 Equipo en línea · Listo",
    desktopOnlineDesc: "Inicia una conexión cifrada E2E con este equipo. El chat se abrirá directamente tras la autorización en tu PC.",
    openChatBtn: "Abrir Chat",
    openNewTab: "Nueva pestaña",
    otherPairedComputers: "OTROS EQUIPOS VINCULADOS",
    accountClientsAria: "Clientes de la cuenta",
    statusOnlineClick: "En línea · Clic para conectar",
    statusOffline: "Desconectado",
    pairAnotherBtn: "+ Vincular otro cliente de escritorio",
    noOnlineComputerTitle: "No se detectó ningún cliente en línea",
    noOnlineComputerDesc: "Asegúrate de que SomniQ Studio esté abierto y con sesión iniciada en tu equipo. Aparecerá aquí automáticamente en cuanto esté en línea.",
    step1Title: "Inicia la App de Escritorio",
    step1Sub: "Abre SomniQ Studio",
    step2Title: "Detección Automática",
    step2Sub: "Haz clic para conectar",
    manualTitleWithDevice: "Vincular un nuevo equipo",
    manualTitleNoDevice: "Vinculación manual con código",
    manualDesc: "Copia el código de conexión en SomniQ Studio (Configuración → Acceso Remoto) y pégalo abajo:",
    cancelBtn: "Cancelar",
    inputPlaceholder: "Pega aquí el código de conexión copiado...",
    startPairingBtn: "Iniciar Vinculación Segura",
    pairingActiveConnecting: "Estableciendo enlace cifrado con tu equipo...",
    pairingActiveApproveOnDesktop: "Por favor pulsa [Aprobar vinculación] en tu PC",
    cancelPairingBtn: "Cancelar Vinculación",
    zeroTrustTitle: "Autorización estricta de Confianza Cero",
    zeroTrustDesc: "Cada conexión o vinculación debe ser confirmada explícitamente mediante una ventana emergente en tu equipo.",
    mobileKicker: "MÓVIL Y TABLET",
    mobileTitle: "Escanea para continuar en tu móvil",
    mobileQrTip: "Compatible con cámara nativa de iOS y Android",
    copyLinkBtn: "Copiar enlace",
    copiedBtn: "Copiado",
    openInNewTabBtn: "Abrir en nueva pestaña",
    e2eEncrypted: "Cifrado Extremo a Extremo",
    switchDeviceBtn: "Cambiar de Equipo",
    openInNewWindowBtn: "Abrir en nueva ventana",
    iframeTitle: "Espacio de Trabajo Remoto SomniQ",
    noClientAvailable: "No hay ningún cliente disponible",
    backToClientsBtn: "Volver a la lista de clientes",
  },
  activity: {
    greetingSub: (days: number) => `Este es tu día ${days} investigando con SomniQ Studio.`,
    tagReviewer: "Auditoría Independiente",
    tagMemory: "Memoria Estructurada en 3 Capas",
    tagGroup: (g: string) => `Grupo: ${g}`,
    tagResearchTier: "Nivel Científico",
    tagTotalCalls: (n: string) => `Llamadas Totales: ${n}`,
    balanceKicker: "CÓMPUTO IA DISPONIBLE",
    refreshBalance: "Actualizar saldo",
    syncing: "Sincronizando...",
    usedQuota: (s: string) => `Cómputo Utilizado: ${s}`,
    cumulativeUsageKicker: "USO ACUMULADO DE INVESTIGACIÓN",
    cumulativeUsageDesc: (n: string) => `Se han completado ${n} interacciones con modelos científicos, abarcando búsqueda bibliográfica, experimentos, redacción y revisión independiente.`,
    dailyCallsTitle: "Llamadas Diarias — Últimos 30 Días",
    dailyCallsPeak: (n: number) => `Pico: ${n}/día`,
    noData: "Sin datos",
    daysAgo30: "Hace 30 días",
    today: "Hoy",
    noCallHistoryYet: "Sin historial de llamadas aún. La tendencia aparecerá tras el primer uso.",
    activeDaysTitle: "Días de Actividad Científica en SomniQ",
    activeDaysTooltip: (days: number) => `Trayectoria registrada a lo largo de ${days} días de actividad`,
    legendLess: "Menos",
    legendMore: "Más",
    legendCalls0: "0 llamadas",
    legendCalls1: "1 - 40 llamadas",
    legendCalls2: "41 - 150 llamadas",
    legendCalls3: "151 - 400 llamadas",
    legendCalls4: "400+ llamadas",
    months: ["Ago", "Sep", "Oct", "Nov", "Dic", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago"],
    heatmapCellCalls: (date: string, calls: string) => `${date}: ${calls} llamadas`,
    heatmapCellZero: (date: string) => `${date}: 0 llamadas`,
    synthesesLabel: "Síntesis y Revisiones Bibliográficas",
    reviewsLabel: "Auditorías de Revisión Independiente",
    topPartnerKicker: "Socio de IA Principal",
    topPartnerCooperated: (n: string) => `Colaboración reciente: ${n} veces`,
    noCallsYet: "Sin registros aún",
    secondPartnerKicker: "Preferencia de Razonamiento y Revisión",
    secondPartnerInvocations: (n: string) => `Ejecutado ${n} veces`,
    noSecondModelYet: "Sin registros de modelo secundario",
  },
  usage: {
    heroTitle: "Análisis de Uso de Cómputo IA",
    heroSubtitle: "Estadísticas en tiempo real de llamadas, consumo de tokens y registros de respuesta en todos los modelos de SomniQ Studio.",
    tagTotal: (n: string) => `Total: ${n}`,
    tagConsumed: (s: string) => `Consumido: ${s}`,
    tagBalance: (s: string) => `Saldo: ${s}`,
    statAvailable: "CUOTA DISPONIBLE",
    statConsumed: "TOTAL CONSUMIDO",
    statTotalRequests: "SOLICITUDES TOTALES",
    statTotalRequestsSub: "En todos los flujos de trabajo",
    statActiveModels: "MODELOS ACTIVOS",
    statActiveModelsSub: "Motores principales",
    trendTitle: "Tendencia de Llamadas Diarias (Últimos 30 Días)",
    breakdownTitle: "Distribución de Uso y Consumo por Modelo",
    refreshLogsBtn: "Actualizar registros",
    dateRangeAria: "Rango de fechas",
    rangeAll: "Todo el tiempo",
    range30d: "Últimos 30 días",
    range7d: "Últimos 7 días",
    range24h: "Últimas 24h",
    metricToggleAria: "Cambiar métrica",
    metricCalls: "Por llamadas",
    metricQuota: "Por consumo",
    donutTotalCalls: "Llamadas Totales",
    donutTotalQuota: "Consumo Total",
    callsUnit: "llamadas",
    noBreakdownRecords: "No se encontraron registros de uso de modelos en el período seleccionado.",
    recentLogsTitle: "Registro Detallado de Invocaciones",
    badgeMonth: "Últimos 30 días",
    filterModelAria: "Filtrar por modelo",
    allModelsOption: "Todos los modelos",
    pageSizeAria: "Registros por página",
    pageSizeOption: (n: number) => `${n} / pág`,
    colTime: "Fecha y Hora",
    colModel: "Modelo",
    colPrompt: "Tokens Entrada",
    colCompletion: "Tokens Salida",
    colQuota: "Consumo",
    colLatency: "Duración",
    loadingMonthLogs: "Cargando registros de llamadas del último mes...",
    noMatchingLogs: "No se encontraron registros de llamadas que coincidan con el filtro en los últimos 30 días",
    paginationInfo: (cur: number, total: number, count: string) =>
      `Página ${cur} de ${total} · Total de ${count} registros en los últimos 30 días`,
    prevPage: "← Anterior",
    nextPage: "Siguiente →",
  },
  plan: {
    heroTitle: "Gestión de Planes y Suscripción Científica",
    subgreetingActive: "Administra tu plan de cómputo para investigación activo, permisos de clúster y detalles de cuota en SomniQ new-api.",
    subgreetingUnsubscribed: "Elige el plan de cómputo para flujos de investigación autónomos que mejor se adapte a ti o a tu laboratorio.",
    tagActivePro: "Suscripción activa: Membresía Pro",
    tagCurrentFree: "Plan actual: Versión Comunitaria",
    tagClusterGroup: (g: string) => `Grupo del Clúster: ${g}`,
    tagDefaultGroup: "Predeterminado",
    tagBalance: (b: string) => `Saldo disponible: ${b}`,
    activeMemberPro: "Membresía Pro de Investigación Científica",
    activeSomniqPro: "Nivel Pro Científico SomniQ",
    statusActiveRunning: "● Activo y en Ejecución",
    poweredByDesc: "Impulsado por la pasarela de LLMs new-api de alto rendimiento y el clúster de investigación",
    clusterGroupLabel: "Grupo de Clúster",
    defaultGroupName: "Mil Investigaciones",
    detailAvailableQuota: "Cómputo Disponible",
    detailUsedQuota: "Cómputo Utilizado",
    detailTotalRequests: "Solicitudes Totales",
    callsUnit: "llamadas",
    detailWorkflowsSub: "Abarca todos los flujos",
    progressTitle: "Progreso de Consumo de Cuota",
    remainingPercent: (pct: string) => `${pct}% restante`,
    freeTierName: "Edición Comunitaria",
    freeTierDesc: "Ideal para exploración científica personal ligera",
    freeTierPrice: "¥0",
    freeTierPeriod: "/ permanente",
    freeTierF1: "Chat de investigación básico",
    freeTierF2: "Modelos base gratuitos (DeepSeek Flash Free, etc.)",
    freeTierF3: "Almacenamiento en espacio de trabajo local",
    currentDefaultBtn: "Predeterminado Actual",
    popularBadge: "MÁS POPULAR · RECOMENDADO",
    proTierName: "Edición Pro Científica",
    proTierDesc: "Cómputo completo de investigación autónoma para investigadores y académicos",
    proTierPrice: "¥199",
    proTierPeriod: "/ mes",
    proTierF1: "Incluye 50.000.000 de Tokens para investigación",
    proTierF2: "Bucle de auditoría y revisión independiente en 16 pasos",
    proTierF3: "Desbloqueo total de los 7 modelos científicos punteros",
    proTierF4: "Sistema de memoria estructurada en 3 niveles para papers",
    proTierF5: "Espacio de trabajo remoto PWA móvil con cifrado E2EE",
    subscribeNowBtn: "Suscribirse Ahora",
    teamTierName: "Edición para Laboratorios y Equipos",
    teamTierDesc: "Para grupos de investigación, laboratorios universitarios y despliegues privados",
    teamTierPrice: "¥999",
    teamTierPeriod: "/ mes",
    teamTierF1: "Incluye 300.000.000 de Tokens para investigación",
    teamTierF2: "Fondo común de cómputo y biblioteca de literatura compartida",
    teamTierF3: "Soporte para despliegue en red local (LAN) o nube privada",
    teamTierF4: "Soporte técnico y asesoría científica dedicada",
    contactTeamBtn: "Contactar para Personalización",
  },
};

export const CONSOLE_COPY: Record<Lang, ConsoleCopy> = {
  zh: consoleZh,
  en: consoleEn,
  es: consoleEs,
};
