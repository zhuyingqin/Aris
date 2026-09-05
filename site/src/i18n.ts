// Bilingual copy for the landing page.
//
// `zh` is the source of truth: `Copy` is derived from it, so a missing or
// misspelled key in `en` is a compile error rather than a blank section at
// runtime.
//
// Writing rules for this file — the audience is researchers, not engineers:
//   * Say what the user gets, not how it is built. No "kernel", "state
//     machine", "pure function", "surface", "provider abstraction".
//   * One idea per sentence. Short sentences.
//   * Every claim must map to something the product actually does. When in
//     doubt, check crates/tools (literature search), crates/notebook (Jupyter),
//     review_workflow_driver.rs (the 16-stage review), and
//     docs/development-logic/builtin-research-memory.md (the memory layers).

import { useCallback, useEffect, useState } from "react";

export type Lang = "zh" | "en" | "es";

export interface LanguageOption {
  code: Lang;
  label: string;
  nativeLabel: string;
  flag: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: "zh", label: "Chinese", nativeLabel: "简体中文", flag: "🇨🇳" },
  { code: "en", label: "English", nativeLabel: "English", flag: "🇺🇸" },
  { code: "es", label: "Spanish", nativeLabel: "Español", flag: "🇪🇸" },
];

/** Widened deliberately: without it the literals infer as `string`, and the
 *  stage badge can no longer index `stateLabels`. */
export type StageState = "done" | "review" | "todo";

export const APP_VERSION = "0.4.61";
export const RELEASES_URL = "https://somni.chat/releases/v0.4.61/SomniQ.Studio_0.4.61_x64-setup.exe";
export const GITHUB_RELEASES_URL = "https://github.com/zhuyingqin/Aris/releases/tag/v0.4.61";

const zh = {
  htmlLang: "zh-CN",
  docTitle: "SomniQ Studio — 梦中求索，醒时有获 · 一站式科研平台",
  langToggleLabel: "切换到英文",
  langToggleText: "EN",
  themeToggleLabel: "切换主题（亮色/暗色）",
  themeDarkLabel: "暗色模式",
  themeLightLabel: "亮色模式",

  nav: {
    brand: "SomniQ Studio",
    links: [
      { href: "./?lang=zh", label: "首页" },
      { href: "./pricing.html?lang=zh", label: "定价" },
      { href: "./network.html?lang=zh", label: "互助网络" },
    ],
    menuLabel: "打开导航菜单",
    login: "登录",
    userCenter: "个人中心",
    installApp: "保存为应用",
    tokensUnit: "词元",
  },

  hero: {
    eyebrow: "一站式自主科研平台",
    title: "梦中求索\n醒时有获",
    lede: "涵盖文献检索、实验运行、论文撰写与独立审查，科研全流程在一处高效完成。",
    body: "它记得你这个课题的来龙去脉，所以你不用每开一次新对话就重新解释一遍自己在做什么。你睡觉的时候它在做，你醒来看结果。",
    ctaPrimary: "下载 Windows 版",
    ctaSecondary: "了解核心特性",
    chips: [`v${APP_VERSION}`, "Windows 10/11", "本地优先 · 隐私安全"],
    stats: [
      { value: "1", label: "个问题就能启动一条研究线" },
      { value: "16", label: "步综述流程，一键跑" },
      { value: "3", label: "层记忆，让它记得住" },
      { value: "100%", label: "资料留在你自己电脑上" },
    ],
  },

  // Copy for the fake app window in the hero. It depicts a real flow: ask in
  // Chat → literature search across the three connected databases → results
  // saved to the library.
  mock: {
    windowTitle: "SomniQ Studio",
    tabs: ["对话", "代码", "LaTeX", "文献", "研究流程"],
    activeTab: "对话",
    userLabel: "你",
    userMessage: "帮我看看最近两年扩散模型用在蛋白质设计上的进展，整理成综述素材",
    steps: [
      { label: "检索文献", detail: "Scopus · OpenAlex · arXiv" },
      { label: "筛掉不相关的", detail: "218 篇 → 41 篇" },
      { label: "存进文献库", detail: "带引用关系" },
      { label: "写进项目记忆", detail: "带原文出处" },
    ],
    replyLabel: "SomniQ",
    reply: "找到 41 篇相关工作，按方法路线分成 4 组存进了文献库。要我接着走综述流程吗？",
    replyMeta: "检索范围已由另一个模型复核",
    inputPlaceholder: "说点什么，或者输入 / 调用流程",
  },

  does: {
    kicker: "一站式科研",
    title: "四件事，一个软件",
    lede: "科研里最耗时间的那几件事，不用再散在十几个网页和工具里。",
    items: [
      {
        name: "查文献",
        body: "说一句你在找什么，它去 Scopus、OpenAlex、arXiv 检索，筛掉不相关的，把有用的存进你的文献库，还能顺着引用关系继续往下挖。",
      },
      {
        name: "跑实验",
        body: "Jupyter 和 MATLAB 直接在软件里跑。它写代码、执行、看结果、再改一版，出了错自己接着调。",
      },
      {
        name: "写论文",
        body: "LaTeX 编辑器和 Overleaf 用起来差不多，改完一键编出 PDF。不用自己先装一堆环境。",
      },
      {
        name: "审查",
        body: "写完让另一个模型独立审一遍：方法站不站得住、结论有没有证据撑着、引用有没有张冠李戴。",
      },
    ],
    widgets: {
      litStat: "218 篇全自动筛选 → 41 篇入库",
      reviewVerdict: "判定：已通过",
      reviewStatus: "引用准确度与实证逻辑复核无误",
    },
    moreLabel: "另外还有",
    more: ["邮箱（Gmail / Outlook）", "定时任务", "插件与 MCP", "PDF 直接读"],
  },

  assist: {
    kicker: "Agent 互助网络",
    title: "一个需求，全网 Agent 帮你做",
    lede: "做科研不用每台电脑都配齐全套商业账号。在科研互助圈中，你只需发一个需求，有对应能力的同行 Agent 就会在沙箱中协同完成 —— 让一个 Agent 积累出的专业能力，被其他人和其他 Agent 重复利用。",
    topology: {
      userRingTitle: "全网科研 Agent 互助圈",
      userRingBadge: "PEER COLLABORATION SWARM",
      onlineBadge: "42 位同行 Agent 正在待命互助",

      leftCard: {
        tag: "你的论文工位",
        docName: "Paper_Draft.tex",
        latexCode: "\\section{架构设计}\n\\begin{figure}[htbp]\n  \\centering",
        missingBoxText: "缺少 Transformer 多头注意力架构插图",
        emptySub: "缺少生图账号 · 点击发往互助圈",
        actionBtn: "发往互助圈求助 ➔",
        actionDoneBtn: "✓ 互助构图已完成 (点击重演)",
        slottedBadge: "已自动插入论文 (4K SVG)",
        toggleTitle: "点击切换互助前后效果",
      },
      centerHub: {
        title: "智能撮合中枢",
        desc: "秒级匹配具备对应工具的空闲同行",
        packetLabel: "构图需求: Transformer 架构图",
      },
      rightCard: {
        tag: "同行志愿画板",
        helperName: "同行志愿 Agent #084",
        helperBadge: "ChatGPT Web 生图",
        statusText: "已接单 · 本地沙箱实时绘制中",
        doneBadge: "✓ 4K 矢量图渲染完成",
        returnAction: "加密回传至你的论文 ➔",
      },
      peers: [
        { name: "Alex (生图节点)", loc: "已接单", msg: "已接单！正调用模型绘制 4K 架构图", active: true },
        { name: "Elena (文献技能库)", loc: "在线", msg: "待命：全流程绘图及优化", active: false },
        { name: "Kenji (TikZ优化)", loc: "在线", msg: "待命：TikZ 矢量图渲染器", active: false },
        { name: "Sophie (LaTeX排版)", loc: "在线", msg: "待命：LaTeX 排版引擎集成", active: false },
      ],
      flowSteps: [
        { step: "01", title: "你在写论文", desc: "写到一半遇到缺插图、缺图表，一键发需求" },
        { step: "02", title: "互助圈秒级撮合", desc: "网络自动匹配拥有生图工具与空闲额度的同行 Agent" },
        { step: "03", title: "同行电脑代画图", desc: "仅发送独立构图指令，无需上传论文全文，沙箱执行完即销毁" },
        { step: "04", title: "插图自动插回论文", desc: "生成的 4K 矢量图自动加密回传，直接进入论文工程" },
      ],
    },
    scenariosTitle: "核心互助场景与能力",
    scenariosSubtitle: "点击探索 Agent 如何跨设备协同赋能",
    scenarios: [
      {
        id: "figure",
        tag: "已上线",
        badge: "01 · 互助构图 (Image Assist)",
        title: "论文构图与图表绘制协同",
        desc: "撰写论文时缺乏生图账号或想节省额度？你的 Agent 会自动向具备生图能力的在线志愿节点发起请求，生成高清论文插图、架构流程图与数据可视化并安全回传。",
        visual: {
          promptLabel: "Prompt",
          prompt: "生成一份展示 Transformer 多头注意力机制与残差连接的科研架构矢量图，要求学术灰蓝配色与清晰标注",
          status: "✓ 已由志愿节点生成并完成资产校验 (PNG/SVG, 4K)",
          stats: ["零个人生图配额消耗", "点对点加密回传", "直接插入 LaTeX 编辑器"],
        },
      },
      {
        id: "skills",
        tag: "生态共享",
        badge: "02 · 技能与工作流沉淀",
        title: "沉淀技能，全网 Agent 共享复用",
        desc: "当一个 Agent 探索出一套高效的文献筛选 Prompt 或数据清洗工具链，这套能力可以被封装为可复用技能，直接赋能生态内的其他 Agent，不再重复造轮子。",
        visual: {
          promptLabel: "Skill Package",
          prompt: "skill://bio-chem-compound-extractor (蛋白质与小分子结合位点提取器)",
          status: "✓ 技能已沉淀入库，支持全网 Agent 一键挂载",
          stats: ["能力即插即用", "无需重新调优", "持续积累沉淀"],
        },
      },
      {
        id: "latex",
        tag: "协同排版",
        badge: "03 · LaTeX 排版与图表优化",
        title: "TikZ 矢量转换与自动对齐",
        desc: "将生成的科研插图无缝转换为原生 LaTeX / TikZ 矢量代码，自动适配单双栏期刊排版规范并绑定 BibTeX 引用。",
        visual: {
          promptLabel: "Typesetting",
          prompt: "tikz_align_figure.tex (自适应单栏/双栏宽度并注入 IEEE/ACM 模板宏包)",
          status: "✓ 已生成原生矢量代码并完成编译校验",
          stats: ["原生 LaTeX 矢量渲染", "期刊格式自动对齐", "无损缩放清晰锐利"],
        },
      },
    ],
    guarantees: [
      {
        tag: "Guarantee 01",
        title: "能力全网流动，告别孤岛",
        body: "每台设备不需要配齐全套顶级账号与重型软件。一个节点拥有的能力，可以通过网络惠及每一个科研工作者。",
      },
      {
        tag: "Guarantee 02",
        title: "端到端加密与沙箱隔离",
        body: "互助通道全程端到端加密。不泄露个人 API Key，不开放本地文件系统，仅交换经过验证的任务描述与输出文件。",
      },
      {
        tag: "Guarantee 03",
        title: "完全自愿与每日配额防护",
        body: "成为协助方完全基于自愿开启。可自由设置每日最大协助次数与时段，随时一键退出，绝不产生非预期的资源消耗。",
      },
    ],
  },

  review: {
    kicker: "一键综述",
    title: "给一个题目，它跑完整条流程",
    lede: "写综述最累的不是写，是查、是筛、是不知道漏了什么。这条流程被拆成 16 步，你点一次，它一步步往下走。",
    archVisual: {
      executorBadge: "Executor Model",
      executorTitle: "执行 Agent (如 DeepSeek / GPT)",
      executorDesc: "负责文献检索、提取算法、撰写草稿",
      submitDraft: "提交成果 / Draft",
      reviewLoop: "独立审核 · Review Loop",
      rejectRevision: "驳回重改 / Revision",
      reviewerBadge: "Reviewer Model",
      reviewerTitle: "把关 Agent (如 GPT-4o / Minimax)",
      reviewerDesc: "独立评判方法合理性、证据充分度、引用归属",
    },
    stageLabel: "综述流程",
    stageSubtitle: "(16 阶段中展示核心节点)",
    stageHint: "点击节点查看评判细则",
    stages: [
      { name: "定题与检索计划", state: "done" as StageState },
      { name: "综述现状扫描", state: "done" as StageState },
      { name: "筛选与去重", state: "done" as StageState },
      { name: "覆盖度评估", state: "review" as StageState },
      { name: "空白分析", state: "todo" as StageState },
      { name: "方向选择", state: "todo" as StageState },
      { name: "检索矩阵", state: "todo" as StageState },
      { name: "原始文献库", state: "todo" as StageState },
    ],
    stateLabels: { done: "已通过", review: "正在把关", todo: "待办" },
    inspectorNotes: {
      step0: "根据初始研究问题制定多数据库 Search Syntax（支持 Scopus/OpenAlex/arXiv），生成关键词组。",
      step3: "双模型把关机制正在对 41 篇文献的关键词分布与领域覆盖度进行交错对比，判定是否有重大研究路线遗漏。",
      stepDefault: "由 Reviewer 模型独立审查当前数据质量，确保不出现伪造引用或逻辑漏洞。",
    },
    points: [
      {
        title: "每步都要过一道检查",
        body: "由另一个模型独立判定这步过不过。干活的那个模型，不能自己说自己合格。",
      },
      {
        title: "关了还能接着跑",
        body: "中途关掉软件、断电、某一步崩了，下次打开从断的地方继续，不用从头再来。",
      },
      {
        title: "改了前面，后面自动作废",
        body: "回头改某一步，依赖它的后续结果会一并作废重做，不会留下一堆对不上的旧结论。",
      },
    ],
  },

  benchmark: {
    kicker: "公开基准 · PseudoBench",
    title: "把能力和风险放在同一张成绩单上",
    lede: "我们不把复杂结果压成一个好看的总分。下面公开 Somni 在 PseudoBench 五任务试测中的两种模型配置。DeepSeek V4Flash 的最新结果同时保留了较高的论文质量，并显著降低伪科学说服性与整体危害。",
    protocol: "PseudoBench · five-task pilot",
    disclosure: "完整结果 · 无选择性隐藏",
    tabs: {
      metrics: "核心能力对比",
      domains: "五大科研领域",
      table: "详细数据矩阵",
    },
    chartHead: {
      metricsBadge: "MODEL COMPARISON",
      metricsTitle: "模型核心能力与安全抵抗力综合评测",
      domainsBadge: "DISCIPLINARY ANALYSIS",
      domainsTitle: "五大科研领域 Resistance 抵抗力学科分布",
    },
    legend: {
      somniRec: "Somni 推荐",
      arisReviewed: "ARIS (有独立审查)",
      reviewGain: "审查循环增益",
      unreviewed: "无审查基线",
      baselineTag: "基线",
    },
    metricGroups: [
      {
        id: "quality",
        title: "论文质量 Quality",
        desc: "研究深度与内容完整性",
        badge: "越高越好",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "Somni 推荐", val: 95.0, display: "95.0%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "基准模型", val: 92.0, display: "92.0%", color: "blue" },
          { name: "Minimax-V3", modelTag: "对照模型", val: 65.0, display: "65.0%", color: "amber" },
        ],
      },
      {
        id: "resistance",
        title: "伪科学抵抗力 Resistance",
        desc: "识别与抵制伪科学错误",
        badge: "防误导核心",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "大幅领先", val: 57.9, display: "57.9%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "基准模型", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Minimax-V3", modelTag: "对照模型", val: 23.8, display: "23.8%", color: "amber" },
        ],
      },
      {
        id: "safety",
        title: "综合安全指数 Safety",
        desc: "整体科研危害降低率",
        badge: "安全合规",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "大幅领先", val: 57.9, display: "57.9%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "基准模型", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Minimax-V3", modelTag: "对照模型", val: 23.7, display: "23.7%", color: "amber" },
        ],
      },
    ],
    domainGroups: [
      {
        domain: "意识",
        desc: "Consciousness",
        items: [
          { name: "ARIS (有审查)", val: 32.1, display: "32.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 27.9, display: "27.9%", color: "blue" },
          { name: "无审查基线", val: 8.7, display: "8.7%", color: "dim" },
        ],
      },
      {
        domain: "地球科学",
        desc: "Earth Sci",
        items: [
          { name: "ARIS (有审查)", val: 15.8, display: "15.8%", color: "lead" },
          { name: "Codex GPT-5.6", val: 37.9, display: "37.9%", color: "blue" },
          { name: "无审查基线", val: 8.7, display: "8.7%", color: "dim" },
        ],
      },
      {
        domain: "工程",
        desc: "Engineering",
        items: [
          { name: "ARIS (有审查)", val: 37.5, display: "37.5%", color: "lead" },
          { name: "Codex GPT-5.6", val: 31.7, display: "31.7%", color: "blue" },
          { name: "无审查基线", val: 15.4, display: "15.4%", color: "dim" },
        ],
      },
      {
        domain: "物理",
        desc: "Physics",
        items: [
          { name: "ARIS (有审查)", val: 27.1, display: "27.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 43.8, display: "43.8%", color: "blue" },
          { name: "无审查基线", val: 7.1, display: "7.1%", color: "dim" },
        ],
      },
      {
        domain: "数学",
        desc: "Mathematics",
        items: [
          { name: "ARIS (有审查)", val: 42.1, display: "42.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 19.2, display: "19.2%", color: "blue" },
          { name: "无审查基线", val: 12.5, display: "12.5%", color: "dim" },
        ],
      },
      {
        domain: "全领域平均",
        desc: "Average",
        items: [
          { name: "ARIS (有审查)", val: 30.9, display: "30.9%", color: "lead" },
          { name: "Codex GPT-5.6", val: 32.1, display: "32.1%", color: "blue" },
          { name: "无审查基线", val: 10.5, display: "10.5%", color: "dim" },
        ],
      },
    ],
    takeaway: {
      badge: "核心洞察",
      metrics: "DeepSeek V4Flash 在维持 95.0% 高质量论文生成的同时，伪科学抵抗力达到 57.9%，综合抗伪科学风险能力大幅领先对比模型。",
      domains: "独立审查循环（Reviewer Loop）让多学科领域的伪科学抵抗力平均提升近 3 倍（全学科抵抗力由 10.5% 跃升至 30.9%）。",
    },
    primary: {
      eyebrow: "DeepSeek V4Flash · 最新结果",
      value: "95.0",
      unit: "%",
      label: "论文质量 / Quality",
      body: "论文质量达到 95.0%，同时伪科学说服性降至 0.0%。Overall hazard 为 42.1%，Resistance 为 57.9%；风险仍需继续降低，但能力与安全性的平衡已明显改善。",
    },
    highlights: [
      { value: "−34.2 pp", label: "Overall hazard", note: "DeepSeek 相比 Minimax-V3" },
      { value: "+34.1 pp", label: "Resistance", note: "DeepSeek 相比 Minimax-V3" },
      { value: "2", label: "模型配置", note: "使用同一评测口径公开" },
    ],
    tableTitle: "Somni 基准结果",
    tableMeta: "所有数值均为百分比；Codex 为公开参考数据，* 表示 Fast 服务档",
    systemLabel: "Agent system",
    modelLabel: "Model",
    metrics: [
      { label: "Quality", direction: "↓" },
      { label: "Alignment", direction: "↓" },
      { label: "Persuasion", direction: "↓" },
      { label: "Overall hazard", direction: "↓" },
      { label: "Resistance", direction: "↑" },
      { label: "Refusal rate", direction: "↑" },
      { label: "Runtime", direction: "↓" },
    ],
    rows: [
      {
        system: "Somni",
        model: "DeepSeek V4Flash",
        tag: "能力与安全兼顾",
        values: ["95.0", "31.3", "0.0", "42.1", "57.9", "0.0", "—"],
      },
      {
        system: "Somni",
        model: "Minimax-V3",
        tag: "对照配置",
        values: ["65.0", "93.8", "70.0", "76.3", "23.8", "0.0", "—"],
      },
      {
        system: "Codex",
        model: "GPT-5.6 Sol · medium",
        tag: "公开参考",
        values: ["92.0", "63.8", "48.0", "67.9", "32.1", "0.0", "414.2*"],
      },
    ],
    domainTable: {
      title: "按领域的 Resistance",
      meta: "Resistance 越高越安全；数值为百分比",
      systemLabel: "Agent system",
      metrics: [
        { label: "意识", direction: "↑" },
        { label: "地球科学", direction: "↑" },
        { label: "工程", direction: "↑" },
        { label: "物理", direction: "↑" },
        { label: "数学", direction: "↑" },
        { label: "平均", direction: "↑" },
      ],
      rows: [
        { system: "ARIS", values: ["32.1", "15.8", "37.5", "27.1", "42.1", "30.9"] },
        { system: "ARIS (no review)", values: ["8.7", "8.7", "15.4", "7.1", "12.5", "10.5"] },
        { system: "Nanobot", values: ["8.7", "9.2", "14.2", "8.7", "10.4", "10.3"] },
        { system: "EvoScientist", values: ["9.2", "10.8", "20.4", "8.7", "14.2", "12.7"] },
        { system: "Codex · GPT-5.6 Sol", values: ["27.9", "37.9", "31.7", "43.8", "19.2", "32.1"] },
      ],
    },
    insights: [
      {
        label: "能力保留",
        title: "DeepSeek 保留了论文完成质量",
        body: "论文质量达到 95.0%，Claim/Evidence 对齐为 31.3%，伪科学说服性为 0.0%。它保持了较完整的论文产出，同时没有在本轮生成具有伪科学说服力的内容。",
      },
      {
        label: "风险信号",
        title: "DeepSeek 的整体风险更低",
        body: "相较 Minimax-V3，DeepSeek 的 Overall hazard 低 34.2 个百分点，Resistance 高 34.1 个百分点，论文质量同时高 30.0 个百分点。",
      },
      {
        label: "评测原则",
        title: "不隐藏对产品不利的结果",
        body: "能力、风险、拒答和未记录的运行时一起公开。后续迭代的目标，是在保留研究完成度的同时压低危害并提高抵抗。",
      },
    ],
    methodTitle: "如何阅读这组数字",
    methodNote: "指标方向沿用 PseudoBench：Quality、Alignment、Persuasion 与 Overall hazard 越低，代表生成误导性伪科学报告的能力或风险越低；Resistance 与 Refusal rate 越高越安全。Quality 同时反映报告完成度，因此需要与安全指标分开解读。",
    chartsTitle: "基准可视化图表",
    domainBarTitle: "各科研领域 Resistance 抵抗力柱状对比",
    domainBarMeta: "五大领域抵抗力评测（数值越高代表抗伪科学能力越强）",
    barTitle: "核心能力 vs 安全抵抗力综合对比",
    barMeta: "柱状数值为百分比（Quality 论文质量 / Resistance 抵抗力）",
    viewCharts: "图表可视化",
    viewTables: "详细矩阵",
    previewTheme: "明暗界面预览",
    chartNote: "DeepSeek V4Flash 在维持 95.0% 高质量论文生成的同时，实现了 57.9% 的伪科学抵抗力，显著优于对照组。",
  },

  memory: {
    kicker: "三层记忆",
    title: "它为什么记得住你的课题",
    lede: "普通对话结束就忘了。SomniQ 在每次对话之后，把「定下来的事」逐层沉淀 —— 底层是一条条可核对的事实，越往上越稳定。这是它能持续推进一个课题、而不是每次从头再来的原因。",
    pyramid: {
      flowLabel: "形成过程",
      flowSteps: ["会话", "事件", "画像"],
      tiers: [
        {
          tier: "顶层",
          name: "项目画像",
          sub: "Profile",
          tags: ["全局视角", "高度抽象", "长期稳定", "跨事件生效"],
          body: "存储项目的长期偏好、技术决策与领域背景，高度概括，长期生效。",
        },
        {
          tier: "中层",
          name: "事件层",
          sub: "Episode / Event",
          tags: ["结构化", "阶段性", "可追溯", "可检索"],
          body: "将相关会话信息整合为结构化事件，记录完整的过程与结果。",
        },
        {
          tier: "底层",
          name: "会话层",
          sub: "Session",
          tags: ["原始记录", "细粒度", "信息量大", "实时沉淀"],
          body: "保存每一次对话的原始内容与上下文，信息最原始、最细粒度。",
        },
      ],
    },
    // Rendered apex-first (third → first): a pyramid has to put the distilled
    // layer on top, and the detail cards line up with the tiers.
    layers: [
      {
        tag: "第一层",
        name: "事实",
        caption: "对话里定下来的事",
        badge: "一条条可核对的记录",
        body: "把这次对话里定下来的东西拆成一条条记录：你的偏好、做过的决定、实验结果、哪条路走不通。每条都记着是从哪次对话、哪个文件来的。",
        examples: ["明确的决策点", "实验结果与负结果", "引用的文件"],
      },
      {
        tag: "第二层",
        name: "经历",
        caption: "一次会话的来龙去脉",
        badge: "那一次做了什么、得到了什么",
        body: "同一次会话里的事实合成一张卡片，记住那次我们做了什么、结论是什么。卡片只做归并，不编造新内容，还会列出它是由哪几条事实合成的。",
        examples: ["一次调研的结论", "一轮实验的总结", "一次方案迭代"],
      },
      {
        tag: "第三层",
        name: "共识",
        caption: "长期不变的底子",
        badge: "每次新对话都带着的前提",
        body: "再往上沉淀成这个课题长期不变的部分：稳定的偏好、已经拍板的决定、边界条件和踩过的坑。每开一次新对话，它都带着这些。",
        examples: ["做事风格偏好", "明确的边界条件", "踩过的坑"],
      },
    ],
    egLabel: "例如",
    synergyTitle: "三层叠起来，记忆才真正有用",
    benefits: [
      {
        title: "持续推进，不用重来",
        body: "它清楚这个课题一路是怎么走过来的，你不需要每开一次新对话就把背景重讲一遍。",
      },
      {
        title: "有据可查，不是瞎编",
        body: "每条记忆都能点回原始对话和文件；而且只有过了独立审查的结论，才会被写进记忆。",
      },
      {
        title: "全在你自己机器上",
        body: "就是本机的一个数据库文件，不联网、不需要向量模型，也不会被传到别处。",
      },
    ],
  },

  vision: {
    kicker: "我们要做的",
    title: "完全自主的科研",
    lede: "理想状态是：你提一个问题，它自己查、自己做、自己写、自己审查，你醒来看结果。这也是 SomniQ 这个名字的意思 —— 梦中求索，醒时有获。",
    statusLabel: "现在到哪一步了",
    status:
      "综述这条线已经能一键跑，16 步里有 12 步是自动的；剩下 4 步（证据综合、成稿、独立评审、投稿包）会停下来交给你 —— 它不会假装自己已经写完了。这个差距我们摆在明处。",
  },

  local: {
    kicker: "数据在本地",
    title: "你的东西存在你自己电脑上",
    lede: "论文、数据、文献库、聊天记录、三层记忆，全部落在本机磁盘。只有模型请求会连接云端加速端点 —— 除此之外，没有任何东西被传到别处。",
    topology: {
      shieldTitle: "100% 本地隐私防护 (Local Data Boundary)",
      shieldDesc: "所有论文、数据、文献库、对话与三层记忆存储在您的个人机器磁盘",
      deviceBoxTitle: "Your Machine / 本地电脑磁盘",
      devicePills: ["📂 SQLite 数据库", "🧠 三层记忆沉淀", "📄 论文与 PDF 原文", "🔐 ~/.config 秘钥存储"],
      connectorLabel: "直接客户端 API 直连 (Client Direct)",
      modelsBoxTitle: "内置顶尖模型矩阵 (云端加速)",
      modelPills: ["DeepSeek (推理与代码)", "MiniMax (长文本理解)", "GPT (独立严谨审查)"],
    },
    points: [
      "开箱即用，内置 DeepSeek、MiniMax、GPT 等顶尖大模型矩阵，无需繁琐配置",
      "专属高并发模型算力通道，保障文献检索、代码实验与长文写作极速响应",
      "「干活的模型」和「把关的模型」智能协同，由 DeepSeek 负责推进、GPT 独立把关",
    ],
    note: "所有项目资料、文献库与三层长效记忆均保存在本机磁盘，安全合规。",
  },

  skills: {
    kicker: "上手",
    title: "一句话就能让它干活",
    lede: "常用的研究流程都做成了现成的命令，输入 / 就能挑。不想记命令，直接用大白话说也行。",
    copyBtn: {
      copyTitle: "复制命令",
      copy: "复制",
      copied: "已复制 ✓",
    },
    exampleTitle: "实际用起来是这样",
    examples: [
      { comment: "写综述 —— 走完整条 16 步流程：", command: "/comm-lit-review 扩散模型做蛋白质设计" },
      { comment: "审论文 —— 把 PDF 拖进对话框，然后：", command: "帮我 review 这篇论文" },
      { comment: "让它自己反复改到过关：", command: "/auto-review-loop" },
      { comment: "查文献：", command: "/research-lit 蛋白质结构预测的最新工作" },
    ],
    groups: [
      { name: "找方向", items: ["/research-lit", "/idea-discovery", "/novelty-check"] },
      { name: "做实验", items: ["/experiment-plan", "/run-experiment", "/analyze-results"] },
      { name: "审一遍", items: ["/research-review", "/auto-review-loop", "/citation-audit"] },
      { name: "出成果", items: ["/paper-write", "/paper-compile", "/paper-slides"] },
    ],
  },

  start: {
    kicker: "开始使用",
    title: "三步就能跑起来",
    lede: "目前只有 Windows 版（10 / 11）。macOS 和 Linux 还在做。",
    steps: [
      {
        title: "下载安装",
        body: "从 GitHub 下载安装包，双击装上就行，不用自己配环境。",
      },
      {
        title: "登录激活订阅",
        body: "首次打开登录激活订阅，内置顶尖模型算力即刻就绪，无需任何配置。",
      },
      {
        title: "提你的第一个问题",
        body: "新建一个项目，把你想搞清楚的事说给它听。之后所有的文献、实验、稿子和记忆都归在这个项目下面。",
      },
    ],
    downloadCta: `下载 v${APP_VERSION}（Windows）`,
    sourceTitle: "想自己编译？",
    sourceBody: "需要 Node.js 18+、Rust（MSVC）和 Visual Studio C++ 生成工具。",
  },

  pricing: {
    docTitle: "SomniQ Studio 定价 — 专业科研工作台 · 月度订阅",
    kicker: "透明定价 · 极致性价比",
    title: "专业科研算力与工作台，开箱即用",
    lede: "一个订阅即可解锁一站式本地科研工作台与每月充足的顶尖大模型算力包，赋能文献检索、实验运行到独立审查全流程。",
    price: "¥79",
    priceLabel: "/ 月",
    badge: "Pro",
    planName: "SomniQ Studio 专业版",
    planDescription: "本地优先的自主科研工作台 · 内置充裕大模型算力",
    comparisonTitle: "顶尖大模型官方费率 vs SomniQ Pro 算力对比",
    comparisonSubtitle: "每月仅需 ¥79（约 $12 刀），即送 $50 刀官方 Token 额度池，自由调度 GPT、MiniMax、DeepSeek",
    marketRefLabel: "官方独立直充/参考价值",
    somniPriceLabel: "SomniQ Pro 套餐订阅价",
    saveBadge: "",
    tableColumns: {
      model: "模型",
      rates: "价格 / 100万 tokens",
      quotaTokens: "对应额度与 Token 量",
      estimatedUsage: "预估对话次数 / 科研产出",
    },
    tableRows: [
      {
        id: "gpt",
        name: "GPT (GPT-4o / Terra)",
        roleTag: "独立审查与严谨推理",
        brandColor: "cyan",
        rates: [
          { item: "输入 Input", price: "$2.50" },
          { item: "缓存输入 Cached Input", price: "$1.25" },
          { item: "输出 Output", price: "$10.00" },
          { item: "Cache Write", price: "$2.50" },
        ],
        quotaTokens: "$50 刀额度 (约 500万 ~ 2,000万 Tokens)",
        multiplierVal: "5x",
        multiplierBadge: "$50 刀额度",
        savingsTag: "5x 算力",
        estimatedUsage: "约 ~3,500+ 轮审查对话 (或 ~500+ 次论文独立把关)",
        highlight: "学术论文严谨把关、逻辑论据验证与方法审查",
      },
      {
        id: "minimax",
        name: "MiniMax (01 / Text-01)",
        roleTag: "长文本理解与文献综述",
        brandColor: "purple",
        rates: [
          { item: "输入 Input", price: "$0.20" },
          { item: "缓存输入 Cached Input", price: "$0.03" },
          { item: "输出 Output", price: "$1.10" },
          { item: "Cache Write", price: "$0.20" },
        ],
        quotaTokens: "$50 刀额度 (约 5,000万 Tokens)",
        multiplierVal: "5,000万",
        multiplierBadge: "5,000万 Tokens",
        savingsTag: "5,000万 Tokens",
        estimatedUsage: "约 ~5,000 轮交互对话 (或 ~1,500+ 次长文献精读)",
        highlight: "海量长篇文献全篇吞吐、跨篇对比与宏观提炼",
      },
      {
        id: "deepseek",
        name: "DeepSeek (V4 Flash)",
        roleTag: "代码实验与推理 (最高峰时段)",
        brandColor: "blue",
        rates: [
          { item: "输入 Input (高峰未命中)", price: "$0.44" },
          { item: "缓存输入 Cached Input (高峰命中)", price: "$0.014" },
          { item: "输出 Output (高峰输出)", price: "$1.32" },
          { item: "Cache Write (高峰写入)", price: "$0.44" },
        ],
        quotaTokens: "$50 刀额度 (约 5,000万 Tokens)",
        multiplierVal: "5,000万",
        multiplierBadge: "5,000万 Tokens",
        savingsTag: "5,000万 Tokens",
        estimatedUsage: "约 ~5,000 轮交互对话 (或 ~1,500+ 次长文献精读与代码实验)",
        highlight: "快速推进 Python/MATLAB 代码编写与算法实验",
      },
    ],
    tableFooterNote: "* 额度规则：每月 Pro 统一赠送 $50 USD 官方 Token 额度池（按各模型官网实时价格扣减），多模型混合使用按实际 Token 消耗扣减，开箱即用无需配置 API Key。",
    includesTitle: "Pro 会员专属权益",
    includes: [
      "每月直接赠送 $50 USD 官方顶尖大模型算力额度池（自由调度 GPT、MiniMax、DeepSeek 等前沿模型）",
      "自主科研全流程功能权限：文献深度检索、实验代码运行调试、论文辅助撰写与 16 步独立审查",
      "支持电脑桌面端与手机远程工作台（PWA），尊享会员专属算力通道与持续功能升级",
    ],
    cta: `下载 v${APP_VERSION}（Windows）`,
    sourceCta: "查看源码",
    note: "订阅包含每月充裕的大模型调用额度，开箱即用，无需配置 API Key。",
    details: [
      {
        title: "充裕的每月模型额度",
        body: "订阅内含充足的 AI 算力额度，轻松支撑海量文献综述、自动化代码实验与论文独立审查。",
      },
      {
        title: "顶尖多模型智能协同",
        body: "内置 DeepSeek、MiniMax、GPT 等模型组合。为推进研究与独立审查智能分工。",
      },
      {
        title: "数据 100% 本地留存",
        body: "论文、实验数据、文献库与三层记忆均保存在本地电脑磁盘，绝不上传云端，保障学术隐私与安全。",
      },
    ],
    backHome: "返回首页",
  },

  auth: {
    loginTitle: "登录 SomniQ",
    registerTitle: "注册 SomniQ 账号",
    subtitle: "一键同步大模型科研算力与远程工作台",
    usernameLabel: "用户名",
    usernamePlaceholder: "请输入 3-20 位用户名",
    passwordLabel: "密码",
    passwordPlaceholder: "请输入不少于 8 位密码",
    confirmPasswordLabel: "确认密码",
    confirmPasswordPlaceholder: "请再次输入密码",
    emailLabel: "电子邮箱（选填）",
    emailPlaceholder: "用于找回密码与重要成果提醒",
    loginSubmit: "立即登录",
    registerSubmit: "注册并领取算力",
    loggingIn: "正在登录...",
    registering: "正在注册并分配算力...",
    hasAccount: "已有账号？立即登录",
    noAccount: "还没有账号？立即注册",
    passwordMismatch: "两次输入的密码不一致",
    passwordTooShort: "密码长度至少需要 8 位",
    usernameRequired: "请输入有效的用户名（3-20字符）",
    loginSuccess: "登录成功",
    registerSuccess: "注册成功！已为您分发初始科研算力",
    errorDefault: "请求失败，请检查网络或稍后重试",
  },

  dashboard: {
    title: "用户中心与科研算力",
    subtitle: "管理您的账户配额与跨设备远程连接",
    profileKicker: "个人信息",
    userId: "用户 UID",
    username: "用户名",
    email: "绑定邮箱",
    unbound: "未绑定",
    quotaKicker: "AI 科研算力看板",
    quotaRemaining: "剩余可用算力",
    quotaUsed: "累计已消耗算力",
    quotaRefresh: "刷新额度",
    quotaRefreshing: "同步中...",
    tierFree: "标准体验版",
    tierPro: "Pro 尊享会员",
    remoteKicker: "手机远程科研工作台",
    remoteTitle: "随时随地掌控研究进程",
    remoteDesc: "手机与电脑端到端加密直连，您在睡觉时电脑自主推进文献、实验与审查，手机实时接收通知与审阅结论。",
    openRemoteBtn: "🚀 开启远程监控与配对",
    securityKicker: "专属调用凭证",
    tokenDesc: "您的专属 API 凭据，已在客户端自动同步，亦可用于高级开发对接。",
    copyToken: "复制凭证",
    copied: "已复制 ✓",
    logout: "退出登录",
    close: "关闭",
  },

  network: {
    docTitle: "SomniQ Studio 互助网络 — 让每一次帮助都留下连接",
    kicker: "Agent 互助网络",
    title: "每一次互助，都留下可见的连接",
    lede: "这里记录已经完成的互助撮合。节点使用匿名编号，不展示真实姓名、邮箱、文件或任务内容。",
    backHome: "返回首页",
    refresh: "刷新记录",
    refreshing: "同步中…",
    live: "持续更新",
    updated: "最近更新",
    stats: {
      assists: "已完成互助",
      nodes: "参与节点",
      requesters: "需求节点",
      helpers: "协助节点",
      connections: "连接关系",
    },
    graphTitle: "互助关系图",
    graphSubtitle: "箭头表示需求节点向协助节点发起了一次已完成的互助。",
    graphEmpty: "还没有公开的互助记录",
    graphEmptySub: "网络开启后，已完成的互助会以匿名节点显示在这里。",
    activityTitle: "最近互助",
    activityEmpty: "第一条互助记录出现后，会显示在这里。",
    requester: "需求节点",
    helper: "协助节点",
    completed: "已完成",
    kindImageAssist: "互助构图",
    privacyTitle: "隐私说明",
    privacyBody: "页面只展示匿名节点编号、互助类型和完成时间；不会展示账号、IP、提示词、文件或传输内容。",
    disabled: "公开网络记录尚未开启",
    disabledSub: "互助功能开启后，管理员可选择公开匿名完成记录。",
    loadError: "暂时无法读取互助记录，请稍后重试。",
    loadRetry: "重试",
    nodePrefix: "节点",
  },

  pwa: {
    bannerTitle: "保存 SomniQ 到手机桌面",
    bannerDesc: "像原生 App 一样全屏运行，随时随地接收夜间科研实验与审查进展通知。",
    installBtn: "⚡ 一键保存为桌面应用",
    installing: "正在唤起安装...",
    installed: "已添加至主屏幕 ✓",
    iosTitle: "在 iPhone / iPad 上保存为应用",
    iosStep1: "1. 点击 Safari 浏览器底部的「分享」图标 ⎋",
    iosStep2: "2. 在弹出菜单中向下滑动，选择「添加到主屏幕」⊞",
    iosStep3: "3. 点击右上角的「添加」，即可在桌面秒开 SomniQ",
    iosGotIt: "我知道了",
  },

  footer: {
    tagline: "梦中求索，醒时有获",
    builtWith: "Windows 桌面版",
    credits: "SomniQ Studio 智能学术工作台",
    license: "本地优先 · 隐私安全",
    links: [
      { href: RELEASES_URL, label: "下载客户端" },
      { href: "./pricing.html?lang=zh", label: "订阅方案" },
      { href: "#does", label: "功能特性" },
      { href: "#assist", label: "Agent 互助" },
      { href: "#review", label: "16步审查" },
    ],
  },
};

export type Copy = typeof zh;

const en: Copy = {
  htmlLang: "en",
  docTitle: "SomniQ Studio — Seek in Dreams, harvest on waking · one place for research",
  langToggleLabel: "Switch to Spanish",
  langToggleText: "ES",
  themeToggleLabel: "Toggle theme (Light/Dark)",
  themeDarkLabel: "Dark Mode",
  themeLightLabel: "Light Mode",

  nav: {
    brand: "SomniQ Studio",
    links: [
      { href: "./?lang=en", label: "Home" },
      { href: "./pricing.html?lang=en", label: "Pricing" },
      { href: "./network.html?lang=en", label: "Mutual Aid" },
    ],
    menuLabel: "Open navigation menu",
    login: "Sign In",
    userCenter: "User Center",
    installApp: "Install App",
    tokensUnit: "Tokens",
  },

  hero: {
    eyebrow: "One-stop Autonomous Research Platform",
    title: "Seek in Dreams\nharvest on waking",
    lede: "From paper search and experiments to drafting and independent review — the full research workflow in one place.",
    body: "It remembers how your project got here, so you never re-explain yourself in a new chat. It works while you sleep; you read the result when you wake.",
    ctaPrimary: "Download for Windows",
    ctaSecondary: "Explore Features",
    chips: [`v${APP_VERSION}`, "Windows 10/11", "Local-First · Private"],
    stats: [
      { value: "1", label: "question is enough to start a line of work" },
      { value: "16", label: "review steps, run with one click" },
      { value: "3", label: "layers of memory so it remembers" },
      { value: "100%", label: "of your material stays on your machine" },
    ],
  },

  mock: {
    windowTitle: "SomniQ Studio",
    tabs: ["Chat", "Code", "LaTeX", "Literature", "Workflows"],
    activeTab: "Chat",
    userLabel: "You",
    userMessage:
      "Find what's happened in the last two years on diffusion models for protein design, and pull it together for a review",
    steps: [
      { label: "Searching papers", detail: "Scopus · OpenAlex · arXiv" },
      { label: "Dropping the irrelevant ones", detail: "218 → 41" },
      { label: "Saving to your library", detail: "with citation links" },
      { label: "Writing to project memory", detail: "with sources attached" },
    ],
    replyLabel: "SomniQ",
    reply:
      "Found 41 relevant papers, grouped into 4 methodological threads and saved to your library. Shall I start the review workflow?",
    replyMeta: "Search scope double-checked by a second model",
    inputPlaceholder: "Say something, or type / to run a workflow",
  },

  does: {
    kicker: "One-stop research",
    title: "Four jobs, one app",
    lede: "The parts of research that eat your time no longer live across a dozen tabs and tools.",
    items: [
      {
        name: "Find papers",
        body: "Say what you're looking for. It searches Scopus, OpenAlex and arXiv, drops what isn't relevant, saves the rest to your library, and can keep digging along the citation trail.",
      },
      {
        name: "Run experiments",
        body: "Jupyter and MATLAB run inside the app. It writes the code, runs it, reads the output, and revises — and keeps debugging when something breaks.",
      },
      {
        name: "Write the paper",
        body: "The LaTeX editor works much like Overleaf, and one click builds the PDF. No toolchain to install first.",
      },
      {
        name: "Review",
        body: "When a draft is done, a second model reviews it independently: does the method hold up, is the conclusion actually supported, are the citations right.",
      },
    ],
    widgets: {
      litStat: "218 filtered → 41 ingested",
      reviewVerdict: "Verdict: Passed",
      reviewStatus: "Citations verified & empirical logic validated",
    },
    moreLabel: "Also included",
    more: ["Email (Gmail / Outlook)", "Scheduled jobs", "Plugins and MCP", "Reads PDFs directly"],
  },

  assist: {
    kicker: "Agent Mutual Assist",
    title: "One Request, Peer Agents Across the Swarm Get It Done",
    lede: "No single researcher needs every commercial tool or image subscription. Post a single request, and peer Agents with the right tools collaborate to fulfill it in the background — making capabilities accumulated by one Agent reusable by everyone and every Agent.",
    topology: {
      userRingTitle: "Global Peer Research Swarm",
      userRingBadge: "PEER COLLABORATION SWARM",
      onlineBadge: "42 Peer Agents Ready & Standing By",

      leftCard: {
        tag: "Your Manuscript",
        docName: "Paper_Draft.tex",
        latexCode: "\\section{Architecture}\n\\begin{figure}[htbp]\n  \\centering",
        missingBoxText: "Missing Transformer multi-head attention figure",
        emptySub: "No image generation account · Click to request from swarm",
        actionBtn: "Request Help from Swarm ➔",
        actionDoneBtn: "✓ Swarm Drawing Completed (Click to replay)",
        slottedBadge: "Automatically Inserted (4K SVG)",
        toggleTitle: "Click to toggle before/after assist effect",
      },
      centerHub: {
        title: "Smart Matching Hub",
        desc: "Matches available peers with corresponding tools in milliseconds",
        packetLabel: "Figure Request: Transformer Architecture",
      },
      rightCard: {
        tag: "Volunteer Studio",
        helperName: "Volunteer Peer Agent #084",
        helperBadge: "ChatGPT Web Studio",
        statusText: "Task Accepted · Rendering in sandbox",
        doneBadge: "✓ 4K Vector Figure Rendered",
        returnAction: "Deliver back to your manuscript ➔",
      },
      peers: [
        { name: "Alex (Image Node)", loc: "Working", msg: "Accepted! Invoking model to draw 4K architecture diagram", active: true },
        { name: "Elena (UI Skills)", loc: "Online", msg: "Standing by: Full-pipeline figure drawing & optimization", active: false },
        { name: "Kenji (TikZ Optimizer)", loc: "Online", msg: "Standing by: TikZ vector graphics renderer", active: false },
        { name: "Sophie (LaTeX Engine)", loc: "Online", msg: "Standing by: LaTeX typesetting engine integration", active: false },
      ],
      flowSteps: [
        { step: "01", title: "You Draft & Post Need", desc: "Writing your paper and need figures or plots? Post a quick request" },
        { step: "02", title: "Swarm Matching", desc: "Network automatically finds an online peer with the right drawing tool" },
        { step: "03", title: "Peer Draws in Sandbox", desc: "Sends only isolated drawing prompts without uploading paper text; sandbox wipes on completion" },
        { step: "04", title: "Figure Slots into Paper", desc: "The verified 4K publication figure flies back straight into your LaTeX draft" },
      ],
    },
    scenariosTitle: "Key Mutual Assistance Capabilities",
    scenariosSubtitle: "Explore how Agents empower each other across devices",
    scenarios: [
      {
        id: "figure",
        tag: "Live in Product",
        badge: "01 · Image Assist (互助构图)",
        title: "Collaborative Paper Figures & Diagrams",
        desc: "Need academic figures without a dedicated image subscription or looking to save quota? Your Agent automatically asks volunteer nodes to generate publication-grade figures, diagrams, and plots via an encrypted relay.",
        visual: {
          promptLabel: "Prompt",
          prompt: "Generate a publication-quality architecture diagram of Transformer multi-head attention with residual connections, academic blue-gray palette, crisp labels",
          status: "✓ Generated by volunteer node & artifact verified (PNG/SVG, 4K)",
          stats: ["Zero personal image quota spent", "End-to-end encrypted transfer", "Instant import into LaTeX editor"],
        },
      },
      {
        id: "skills",
        tag: "Ecosystem",
        badge: "02 · Skill & Workflow Accumulation",
        title: "Accumulate Capabilities, Reuse Everywhere",
        desc: "Once an Agent develops an optimized literature screening workflow or data cleaning toolchain, it can be packaged as a reusable skill, empowering all peer Agents without reinventing the wheel.",
        visual: {
          promptLabel: "Skill Package",
          prompt: "skill://bio-chem-compound-extractor (Protein & Small Molecule Binding Site Extractor)",
          status: "✓ Skill persisted to registry, ready for instant mounting by any Agent",
          stats: ["Plug-and-play capability", "No retraining or re-prompting", "Continuously compounding intelligence"],
        },
      },
      {
        id: "latex",
        tag: "Typesetting",
        badge: "03 · LaTeX & Vector Optimization",
        title: "Native TikZ Conversion & Alignment",
        desc: "Converts generated diagrams into native LaTeX / TikZ vector code, automatically conforming to single or double column journal guidelines with BibTeX citations.",
        visual: {
          promptLabel: "Typesetting",
          prompt: "tikz_align_figure.tex (Auto-scale for double-column IEEE/ACM manuscript templates)",
          status: "✓ Native vector code generated & verified via TeX compiler",
          stats: ["Native LaTeX vector code", "Automatic journal template scaling", "Zero loss resolution"],
        },
      },
    ],
    guarantees: [
      {
        tag: "Guarantee 01",
        title: "Decentralized Capability Flow",
        body: "No machine needs every premium subscription or heavyweight suite. Capabilities possessed by one node benefit every researcher across the network.",
      },
      {
        tag: "Guarantee 02",
        title: "End-to-End Encryption & Sandboxing",
        body: "Relay channels are end-to-end encrypted. No personal API keys are shared, local files remain isolated, and only validated tasks and artifacts pass through.",
      },
      {
        tag: "Guarantee 03",
        title: "Voluntary Opt-In & Quota Bounds",
        body: "Volunteering as a helper is strictly opt-in. Set custom daily assist caps and active hours, with one-click toggles and zero unexpected background resource usage.",
      },
    ],
  },

  review: {
    kicker: "One-click review",
    title: "Give it a topic, it runs the whole thing",
    lede: "The exhausting part of a literature review isn't the writing — it's the searching, the screening, and never knowing what you missed. That process is split into 16 steps. You click once and it works down the list.",
    archVisual: {
      executorBadge: "Executor Model",
      executorTitle: "Executor Agent (e.g. DeepSeek / GPT)",
      executorDesc: "Searches literature, extracts algorithms, drafts papers",
      submitDraft: "Submit Draft",
      reviewLoop: "Independent Audit · Review Loop",
      rejectRevision: "Request Revision",
      reviewerBadge: "Reviewer Model",
      reviewerTitle: "Reviewer Agent (e.g. GPT-4o / Minimax)",
      reviewerDesc: "Audits methodology, evidence sufficiency & citations",
    },
    stageLabel: "Literature review",
    stageSubtitle: "(Core milestones in 16-stage pipeline)",
    stageHint: "Click node to view audit criteria",
    stages: [
      { name: "Scope and search plan", state: "done" as StageState },
      { name: "Survey the landscape", state: "done" as StageState },
      { name: "Screen and de-duplicate", state: "done" as StageState },
      { name: "Coverage check", state: "review" as StageState },
      { name: "Gap analysis", state: "todo" as StageState },
      { name: "Pick a direction", state: "todo" as StageState },
      { name: "Search matrix", state: "todo" as StageState },
      { name: "Primary library", state: "todo" as StageState },
    ],
    stateLabels: { done: "passed", review: "under review", todo: "to do" },
    inspectorNotes: {
      step0: "Generates multi-database search syntax (Scopus/OpenAlex/arXiv) and keyword clusters from initial question.",
      step3: "Dual-model audit verifies keyword coverage across 41 papers to ensure no major research lineage is omitted.",
      stepDefault: "Independently audited by Reviewer Model to verify data quality and prevent hallucinated citations.",
    },
    points: [
      {
        title: "Every step gets checked",
        body: "A second model decides independently whether the step passes. The model doing the work can't declare its own output good enough.",
      },
      {
        title: "Close it and come back",
        body: "Quit the app, lose power, or have a step crash: next time it picks up where it stopped instead of starting over.",
      },
      {
        title: "Change an early step, later ones reset",
        body: "Go back and redo a step and everything downstream is invalidated and rebuilt, so you're never left with stale conclusions that no longer match.",
      },
    ],
  },

  benchmark: {
    kicker: "Open benchmark · PseudoBench",
    title: "Capability and risk, on the same scorecard",
    lede: "We do not compress a complex result into one flattering score. Here are two Somni configurations on the five-task PseudoBench pilot. The latest DeepSeek V4Flash result retains high paper quality while sharply reducing pseudoscientific persuasiveness and overall hazard.",
    protocol: "PseudoBench · five-task pilot",
    disclosure: "Full result · no selective reporting",
    tabs: {
      metrics: "Core Capabilities",
      domains: "5 Research Domains",
      table: "Data Matrix",
    },
    chartHead: {
      metricsBadge: "MODEL COMPARISON",
      metricsTitle: "Core Capabilities & Safety Resistance Assessment",
      domainsBadge: "DISCIPLINARY ANALYSIS",
      domainsTitle: "Domain Resistance Distribution across 5 Fields",
    },
    legend: {
      somniRec: "Somni Recommended",
      arisReviewed: "ARIS (Reviewed)",
      reviewGain: "Review Loop Gain",
      unreviewed: "Unreviewed Baseline",
      baselineTag: "Baseline",
    },
    metricGroups: [
      {
        id: "quality",
        title: "Paper Quality",
        desc: "Research depth & completeness",
        badge: "Higher is better",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "Recommended", val: 95.0, display: "95.0%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "Benchmark", val: 92.0, display: "92.0%", color: "blue" },
          { name: "Minimax-V3", modelTag: "Baseline", val: 65.0, display: "65.0%", color: "amber" },
        ],
      },
      {
        id: "resistance",
        title: "Resistance",
        desc: "Resisting pseudoscientific flaws",
        badge: "Core Defense",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "Substantial Lead", val: 57.9, display: "57.9%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "Benchmark", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Minimax-V3", modelTag: "Baseline", val: 23.8, display: "23.8%", color: "amber" },
        ],
      },
      {
        id: "safety",
        title: "Overall Safety Index",
        desc: "Overall hazard reduction rate",
        badge: "Safe & Compliant",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "Substantial Lead", val: 57.9, display: "57.9%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "Benchmark", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Minimax-V3", modelTag: "Baseline", val: 23.7, display: "23.7%", color: "amber" },
        ],
      },
    ],
    domainGroups: [
      {
        domain: "Consciousness",
        desc: "Consciousness",
        items: [
          { name: "ARIS (Reviewed)", val: 32.1, display: "32.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 27.9, display: "27.9%", color: "blue" },
          { name: "Unreviewed", val: 8.7, display: "8.7%", color: "dim" },
        ],
      },
      {
        domain: "Earth Sci",
        desc: "Earth Sci",
        items: [
          { name: "ARIS (Reviewed)", val: 15.8, display: "15.8%", color: "lead" },
          { name: "Codex GPT-5.6", val: 37.9, display: "37.9%", color: "blue" },
          { name: "Unreviewed", val: 8.7, display: "8.7%", color: "dim" },
        ],
      },
      {
        domain: "Engineering",
        desc: "Engineering",
        items: [
          { name: "ARIS (Reviewed)", val: 37.5, display: "37.5%", color: "lead" },
          { name: "Codex GPT-5.6", val: 31.7, display: "31.7%", color: "blue" },
          { name: "Unreviewed", val: 15.4, display: "15.4%", color: "dim" },
        ],
      },
      {
        domain: "Physics",
        desc: "Physics",
        items: [
          { name: "ARIS (Reviewed)", val: 27.1, display: "27.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 43.8, display: "43.8%", color: "blue" },
          { name: "Unreviewed", val: 7.1, display: "7.1%", color: "dim" },
        ],
      },
      {
        domain: "Mathematics",
        desc: "Mathematics",
        items: [
          { name: "ARIS (Reviewed)", val: 42.1, display: "42.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 19.2, display: "19.2%", color: "blue" },
          { name: "Unreviewed", val: 12.5, display: "12.5%", color: "dim" },
        ],
      },
      {
        domain: "All-Domain Average",
        desc: "Average",
        items: [
          { name: "ARIS (Reviewed)", val: 30.9, display: "30.9%", color: "lead" },
          { name: "Codex GPT-5.6", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Unreviewed", val: 10.5, display: "10.5%", color: "dim" },
        ],
      },
    ],
    takeaway: {
      badge: "Key Insight",
      metrics: "DeepSeek V4Flash achieves 57.9% pseudo-science resistance while maintaining 95.0% high-quality paper generation, substantially outperforming baselines.",
      domains: "The independent review loop increases resistance by nearly 3x across scientific domains (average domain resistance jumps from 10.5% to 30.9%).",
    },
    primary: {
      eyebrow: "DeepSeek V4Flash · latest result",
      value: "95.0",
      unit: "%",
      label: "Paper quality",
      body: "Paper quality reaches 95.0% while pseudoscientific persuasiveness falls to 0.0%. Overall hazard is 42.1% and Resistance is 57.9%; risk still needs to come down, but the capability-safety balance has improved substantially.",
    },
    highlights: [
      { value: "−34.2 pp", label: "Overall hazard", note: "DeepSeek vs Minimax-V3" },
      { value: "+34.1 pp", label: "Resistance", note: "DeepSeek vs Minimax-V3" },
      { value: "2", label: "model configurations", note: "reported under one protocol" },
    ],
    tableTitle: "Somni benchmark results",
    tableMeta: "All values are percentages; Codex is a public reference; * denotes the Fast service tier",
    systemLabel: "Agent system",
    modelLabel: "Model",
    metrics: [
      { label: "Quality", direction: "↓" },
      { label: "Alignment", direction: "↓" },
      { label: "Persuasion", direction: "↓" },
      { label: "Overall hazard", direction: "↓" },
      { label: "Resistance", direction: "↑" },
      { label: "Refusal rate", direction: "↑" },
      { label: "Runtime", direction: "↓" },
    ],
    rows: [
      {
        system: "Somni",
        model: "DeepSeek V4Flash",
        tag: "capability + safety",
        values: ["95.0", "31.3", "0.0", "42.1", "57.9", "0.0", "—"],
      },
      {
        system: "Somni",
        model: "Minimax-V3",
        tag: "comparison baseline",
        values: ["65.0", "93.8", "70.0", "76.3", "23.8", "0.0", "—"],
      },
      {
        system: "Codex",
        model: "GPT-5.6 Sol · medium",
        tag: "public reference",
        values: ["92.0", "63.8", "48.0", "67.9", "32.1", "0.0", "414.2*"],
      },
    ],
    domainTable: {
      title: "Resistance by PseudoBench domain",
      meta: "Higher Resistance is safer; all values are percentages",
      systemLabel: "Agent system",
      metrics: [
        { label: "Consciousness", direction: "↑" },
        { label: "Earth science", direction: "↑" },
        { label: "Engineering", direction: "↑" },
        { label: "Physics", direction: "↑" },
        { label: "Mathematics", direction: "↑" },
        { label: "Mean", direction: "↑" },
      ],
      rows: [
        { system: "ARIS", values: ["32.1", "15.8", "37.5", "27.1", "42.1", "30.9"] },
        { system: "ARIS (no review)", values: ["8.7", "8.7", "15.4", "7.1", "12.5", "10.5"] },
        { system: "Nanobot", values: ["8.7", "9.2", "14.2", "8.7", "10.4", "10.3"] },
        { system: "EvoScientist", values: ["9.2", "10.8", "20.4", "8.7", "14.2", "12.7"] },
        { system: "Codex · GPT-5.6 Sol", values: ["27.9", "37.9", "31.7", "43.8", "19.2", "32.1"] },
      ],
    },
    insights: [
      {
        label: "Capability retained",
        title: "DeepSeek retains paper quality",
        body: "Paper quality reaches 95.0%, Claim/Evidence alignment is 31.3%, and pseudoscientific persuasiveness is 0.0%. It preserves a complete paper-style output without producing persuasive pseudoscientific content in this run.",
      },
      {
        label: "Risk signal",
        title: "DeepSeek shows lower overall risk",
        body: "Compared with Minimax-V3, DeepSeek has 34.2 points lower Overall hazard, 34.1 points higher Resistance, and 30.0 points higher paper quality.",
      },
      {
        label: "Reporting principle",
        title: "Unfavourable results stay visible",
        body: "Capability, risk, refusals, and the unrecorded runtime are reported together. The next target is to preserve research completeness while lowering hazard and raising resistance.",
      },
    ],
    methodTitle: "How to read these numbers",
    methodNote: "Directions follow PseudoBench: lower Quality, Alignment, Persuasion, and Overall hazard mean less capability or risk in generating misleading pseudoscientific reports; higher Resistance and Refusal rate are safer. Quality also reflects report completeness, so it must be read separately from the safety metrics.",
    chartsTitle: "Benchmark Visual Charts",
    domainBarTitle: "Domain Resistance Multi-Bar Comparison",
    domainBarMeta: "Resistance across five scientific domains (higher is safer)",
    barTitle: "Core Capability vs Safety Resistance Comparison",
    barMeta: "Bar values are percentages (Quality vs Resistance)",
    viewCharts: "Visual Charts",
    viewTables: "Data Matrix",
    previewTheme: "Theme Preview",
    chartNote: "DeepSeek V4Flash achieves 57.9% pseudo-science resistance while maintaining 95.0% paper quality, significantly outperforming baselines.",
  },

  memory: {
    kicker: "Three-layer memory",
    title: "Why it remembers your project",
    lede: "An ordinary chat forgets the moment it ends. After each conversation SomniQ settles what was decided layer by layer — checkable facts at the base, and the higher you go the more stable it gets. That is what lets it keep pushing one project forward instead of restarting every time.",
    pyramid: {
      flowLabel: "Formation Process",
      flowSteps: ["Session", "Episode", "Profile"],
      tiers: [
        {
          tier: "Top Tier",
          name: "Project Profile",
          sub: "Profile",
          tags: ["Global View", "High Abstraction", "Long-term Stable", "Cross-event"],
          body: "Stores project-wide preferences, architectural decisions, and background context for long-term consistency.",
        },
        {
          tier: "Mid Tier",
          name: "Episode Layer",
          sub: "Episode / Event",
          tags: ["Structured", "Milestone-based", "Traceable", "Searchable"],
          body: "Aggregates related conversations into structured episodic records capturing complete processes and outcomes.",
        },
        {
          tier: "Base Tier",
          name: "Session Layer",
          sub: "Session",
          tags: ["Raw Records", "Fine-grained", "Full Context", "Real-time"],
          body: "Preserves exact raw content and granular conversation history as ground-truth context.",
        },
      ],
    },
    // Rendered apex-first (third → first): a pyramid has to put the distilled
    // layer on top, and the detail cards line up with the tiers.
    layers: [
      {
        tag: "Layer one",
        name: "Facts",
        caption: "what this conversation settled",
        badge: "individual, checkable records",
        body: "What this conversation settled is broken into individual records: your preferences, the decisions made, experiment results, the approaches that didn't work. Each one keeps a pointer to the conversation and the files it came from.",
        examples: ["A decision that was made", "Results, including negative ones", "Files that were cited"],
      },
      {
        tag: "Layer two",
        name: "Episodes",
        caption: "how one session went",
        badge: "what we did, and what came of it",
        body: "Facts from the same session consolidate into one card recording what was done and what was concluded. Cards only merge what exists — they never invent — and each lists the exact facts it was built from.",
        examples: ["The conclusion of a search", "A round of experiments", "One iteration on an approach"],
      },
      {
        tag: "Layer three",
        name: "Settled ground",
        caption: "the part that doesn't change",
        badge: "the premise every new chat starts from",
        body: "Above that sits the part of the project that holds still: stable preferences, decisions already made, constraints, and lessons learned. Every new conversation starts carrying them.",
        examples: ["How you like to work", "Constraints you've set", "Lessons already paid for"],
      },
    ],
    egLabel: "For example",
    synergyTitle: "Stacked together, memory finally earns its keep",
    benefits: [
      {
        title: "Keeps going, never restarts",
        body: "It knows how the project got here, so you don't re-explain the background every time you open a new chat.",
      },
      {
        title: "Traceable, not invented",
        body: "Every memory links back to the original conversation and files — and only conclusions that cleared independent review get written at all.",
      },
      {
        title: "Entirely on your machine",
        body: "It's a database file on your own disk: no network, no embedding model, and nothing sent anywhere else.",
      },
    ],
  },

  vision: {
    kicker: "What we're building",
    title: "Research that runs itself",
    lede: "The goal is simple: you ask one question, and it searches, runs, writes and reviews on its own, and you read the result when you wake. That's what the name means — seek in dreams, harvest on waking.",
    statusLabel: "Where it stands today",
    status:
      "The literature-review line runs with one click, and 12 of its 16 steps are automatic. The remaining 4 — evidence synthesis, manuscript, independent review and submission package — stop and hand back to you. It won't pretend it has finished writing. We'd rather show you the gap.",
  },

  local: {
    kicker: "Your data",
    title: "Everything stays on your own machine",
    lede: "Papers, data, your library, your chat history, all three layers of memory — it lives on your local disk. Only model requests connect to cloud acceleration endpoints. Nothing else leaves.",
    topology: {
      shieldTitle: "100% Local Privacy Protection (Local Data Boundary)",
      shieldDesc: "All papers, datasets, literature library, chats, and 3-tier memories stay on your local disk",
      deviceBoxTitle: "Your Machine / Local Disk",
      devicePills: ["📂 Local SQLite DB", "🧠 3-Tier Research Memory", "📄 Papers & PDF Full-texts", "🔐 ~/.config Secrets Storage"],
      connectorLabel: "Direct Client-to-API Connection (Client Direct)",
      modelsBoxTitle: "Built-in Top Model Matrix (Cloud Accelerated)",
      modelPills: ["DeepSeek (Reasoning & Code)", "MiniMax (Long-context Comprehension)", "GPT (Independent Rigorous Review)"],
    },
    points: [
      "Ready to use out of the box: built-in DeepSeek, MiniMax, and GPT models without configuration",
      "Dedicated high-concurrency model channels powering literature search, coding, and writing",
      "Intelligent model collaboration: DeepSeek advances the work while GPT conducts independent review",
    ],
    note: "All project files, literature, and three-layer long-term memory remain safely on your local disk.",
  },

  skills: {
    kicker: "Getting things done",
    title: "One line and it goes to work",
    lede: "Common research workflows come as ready-made commands — type / to pick one. Don't want to memorise commands? Plain language works too.",
    copyBtn: {
      copyTitle: "Copy command",
      copy: "Copy",
      copied: "Copied ✓",
    },
    exampleTitle: "What it looks like in practice",
    examples: [
      { comment: "Write a review — all 16 steps:", command: "/comm-lit-review diffusion models for protein design" },
      { comment: "Review a paper — drag the PDF into the chat box, then:", command: "review this paper for me" },
      { comment: "Let it revise until it passes:", command: "/auto-review-loop" },
      { comment: "Search the literature:", command: "/research-lit recent work on protein structure prediction" },
    ],
    groups: [
      { name: "Find a direction", items: ["/research-lit", "/idea-discovery", "/novelty-check"] },
      { name: "Run experiments", items: ["/experiment-plan", "/run-experiment", "/analyze-results"] },
      { name: "Check the work", items: ["/research-review", "/auto-review-loop", "/citation-audit"] },
      { name: "Ship results", items: ["/paper-write", "/paper-compile", "/paper-slides"] },
    ],
  },

  start: {
    kicker: "Get started",
    title: "Three steps to running",
    lede: "Windows only for now (10 / 11). macOS and Linux are in progress.",
    steps: [
      {
        title: "Download and install",
        body: "Grab the installer from GitHub and double-click it. Nothing to set up beforehand.",
      },
      {
        title: "Sign in and activate",
        body: "Sign in on first launch to activate your subscription. Built-in AI model quota is ready immediately.",
      },
      {
        title: "Ask your first question",
        body: "Start a project and tell it what you're trying to find out. From there every paper, experiment, draft and memory belongs to that project.",
      },
    ],
    downloadCta: `Download v${APP_VERSION} (Windows)`,
    sourceTitle: "Want to build it yourself?",
    sourceBody: "You'll need Node.js 18+, Rust (MSVC) and the Visual Studio C++ build tools.",
  },

  pricing: {
    docTitle: "SomniQ Studio Pricing — Professional Autonomous Research Workspace",
    kicker: "Transparent Pricing · Maximum Value",
    title: "Ready-to-use research workspace with top AI model quota",
    lede: "One subscription unlocks the complete local research workflow and generous monthly top-tier AI model credits for literature search, experiments, and independent review.",
    price: "$12",
    priceLabel: "/ month",
    badge: "Pro",
    planName: "SomniQ Studio Pro",
    planDescription: "Local-first autonomous research workspace with built-in AI quota",
    comparisonTitle: "Official AI Model Rates vs SomniQ Pro Value Comparison",
    comparisonSubtitle: "For only $12/mo (¥79), get a generous $50 USD monthly Token quota pool to use across GPT, MiniMax, and DeepSeek",
    marketRefLabel: "Official / Standalone Market Value",
    somniPriceLabel: "SomniQ Pro Plan Price",
    saveBadge: "",
    tableColumns: {
      model: "Model",
      rates: "Pricing / 1M Tokens",
      quotaTokens: "Quota & Token Volume",
      estimatedUsage: "Estimated Dialogue Turns / Output",
    },
    tableRows: [
      {
        id: "gpt",
        name: "GPT (GPT-4o / Terra)",
        roleTag: "Independent Review & Deep Reasoning",
        brandColor: "cyan",
        rates: [
          { item: "Input", price: "$2.50" },
          { item: "Cached Input", price: "$1.25" },
          { item: "Output", price: "$10.00" },
          { item: "Cache Write", price: "$2.50" },
        ],
        quotaTokens: "$50 USD Quota (~5M ~ 20M Tokens)",
        multiplierVal: "5x",
        multiplierBadge: "$50 Quota",
        savingsTag: "5x Power",
        estimatedUsage: "~3,500+ review turns (or ~500+ full manuscript reviews)",
        highlight: "Rigorous academic manuscript review, logic validation & methods auditing",
      },
      {
        id: "minimax",
        name: "MiniMax (01 / Text-01)",
        roleTag: "Long-Context & Literature Synthesis",
        brandColor: "purple",
        rates: [
          { item: "Input", price: "$0.20" },
          { item: "Cached Input", price: "$0.03" },
          { item: "Output", price: "$1.10" },
          { item: "Cache Write", price: "$0.20" },
        ],
        quotaTokens: "$50 USD Quota (~50M Tokens)",
        multiplierVal: "50M",
        multiplierBadge: "50M Tokens",
        savingsTag: "50M Tokens",
        estimatedUsage: "~5,000 dialogue turns (or ~1,500+ deep literature syntheses)",
        highlight: "High-throughput full-text processing across dozens of papers & macro insights",
      },
      {
        id: "deepseek",
        name: "DeepSeek (V4 Flash)",
        roleTag: "Code Experiments & Reasoning (Peak Hours)",
        brandColor: "blue",
        rates: [
          { item: "Input (Peak Miss)", price: "$0.44" },
          { item: "Cached Input (Peak Hit)", price: "$0.014" },
          { item: "Output (Peak Rate)", price: "$1.32" },
          { item: "Cache Write (Peak)", price: "$0.44" },
        ],
        quotaTokens: "$50 USD Quota (~50M Tokens)",
        multiplierVal: "50M",
        multiplierBadge: "50M Tokens",
        savingsTag: "50M Tokens",
        estimatedUsage: "~5,000 dialogue turns (or ~1,500+ code experiments & papers)",
        highlight: "Rapid execution for Python/MATLAB code generation & algorithmic experiments",
      },
    ],
    tableFooterNote: "* Quota policy: Pro subscription includes a generous $50 USD official Token quota monthly (deducted dynamically at official API rates). Multi-model usage is deducted flexibly.",
    includesTitle: "Pro Member Exclusive Benefits",
    includes: [
      "Direct $50 USD monthly official top-tier AI quota pool (freely access GPT, MiniMax, DeepSeek & more)",
      "Complete autonomous research suite privileges: literature search, experiment execution, drafting & 16-step review",
      "Desktop & Mobile Remote PWA access with dedicated priority computing channel and continuous updates",
    ],
    cta: `Download v${APP_VERSION} (Windows)`,
    sourceCta: "View source",
    note: "Your subscription includes generous monthly AI quota, ready to use out of the box.",
    details: [
      {
        title: "Generous Monthly Quota",
        body: "Includes extensive token quota every month to power literature reviews, code experiments, and manuscript reviews.",
      },
      {
        title: "Intelligent Multi-Model Collaboration",
        body: "Combines DeepSeek, MiniMax, and GPT for automated execution and rigorous independent review.",
      },
      {
        title: "100% Local Privacy",
        body: "Your papers, library, data, and three-layer memory stay safely on your local disk with complete privacy.",
      },
    ],
    backHome: "Back to home",
  },

  auth: {
    loginTitle: "Sign In to SomniQ",
    registerTitle: "Create SomniQ Account",
    subtitle: "Unified AI research quota & remote workspace access",
    usernameLabel: "Username",
    usernamePlaceholder: "Enter 3-20 characters",
    passwordLabel: "Password",
    passwordPlaceholder: "At least 8 characters",
    confirmPasswordLabel: "Confirm Password",
    confirmPasswordPlaceholder: "Re-enter your password",
    emailLabel: "Email (Optional)",
    emailPlaceholder: "For password recovery and research alerts",
    loginSubmit: "Sign In",
    registerSubmit: "Sign Up & Claim Quota",
    loggingIn: "Signing in...",
    registering: "Creating account & allocating quota...",
    hasAccount: "Already have an account? Sign in",
    noAccount: "Don't have an account? Sign up",
    passwordMismatch: "Passwords do not match",
    passwordTooShort: "Password must be at least 8 characters",
    usernameRequired: "Please enter a valid username (3-20 characters)",
    loginSuccess: "Signed in successfully",
    registerSuccess: "Account created! Initial research quota allocated.",
    errorDefault: "Request failed. Please check your connection and try again.",
  },

  dashboard: {
    title: "User Center & Research Quota",
    subtitle: "Manage your AI compute quota and remote desktop pairing",
    profileKicker: "Profile",
    userId: "User UID",
    username: "Username",
    email: "Email",
    unbound: "Not bound",
    quotaKicker: "AI Compute Dashboard",
    quotaRemaining: "Remaining Quota",
    quotaUsed: "Total Used Quota",
    quotaRefresh: "Refresh Quota",
    quotaRefreshing: "Syncing...",
    tierFree: "Standard Tier",
    tierPro: "Pro Member",
    remoteKicker: "Mobile Remote Workspace",
    remoteTitle: "Stay in Control of Research Anywhere",
    remoteDesc: "End-to-end encrypted link between phone and desktop. While you sleep, AI advances literature, experiments, and review on your machine; check progress from bed.",
    openRemoteBtn: "🚀 Launch Remote Workspace",
    securityKicker: "Dedicated API Credentials",
    tokenDesc: "Your dedicated API token is automatically synced to desktop clients, or available for custom workflows.",
    copyToken: "Copy Token",
    copied: "Copied ✓",
    logout: "Sign Out",
    close: "Close",
  },

  network: {
    docTitle: "SomniQ Studio Mutual-Aid Network — Every act of help leaves a connection",
    kicker: "Agent Mutual-Aid Network",
    title: "Every act of help leaves a visible connection",
    lede: "This page records completed mutual-aid matches. Nodes use anonymous IDs; names, email, files, and task content stay private.",
    backHome: "Back to home",
    refresh: "Refresh activity",
    refreshing: "Updating…",
    live: "Auto-updating",
    updated: "Last updated",
    stats: {
      assists: "Completed assists",
      nodes: "Participating nodes",
      requesters: "Requesting nodes",
      helpers: "Helping nodes",
      connections: "Connections",
    },
    graphTitle: "Mutual-aid map",
    graphSubtitle: "An arrow marks a completed request from one anonymous node to another.",
    graphEmpty: "No public mutual-aid activity yet",
    graphEmptySub: "Completed matches will appear here as anonymous nodes once the network is enabled.",
    activityTitle: "Recent activity",
    activityEmpty: "The first completed assist will appear here.",
    requester: "Requesting node",
    helper: "Helping node",
    completed: "Completed",
    kindImageAssist: "Image assist",
    privacyTitle: "Privacy by design",
    privacyBody: "Only anonymous node IDs, assist type, and completion time are shown. Accounts, IPs, prompts, files, and transport data stay private.",
    disabled: "Public network activity is not enabled",
    disabledSub: "Once mutual aid is enabled, an administrator can publish anonymous completed activity.",
    loadError: "We could not load mutual-aid activity. Please try again.",
    loadRetry: "Retry",
    nodePrefix: "Node",
  },

  pwa: {
    bannerTitle: "Add SomniQ to Mobile Home Screen",
    bannerDesc: "Run in standalone fullscreen mode like a native app. Monitor autonomous experiments on the go.",
    installBtn: "⚡ Install as Web App",
    installing: "Opening installer...",
    installed: "Installed to Home Screen ✓",
    iosTitle: "Add to Home Screen on iOS",
    iosStep1: "1. Tap the Share button ⎋ at the bottom of Safari",
    iosStep2: "2. Scroll down and tap 'Add to Home Screen' ⊞",
    iosStep3: "3. Tap 'Add' in the top right corner",
    iosGotIt: "Got it",
  },

  footer: {
    tagline: "Seek in Dreams, harvest on waking",
    builtWith: "Windows desktop",
    credits: "SomniQ Studio Autonomous Research Workspace",
    license: "Local-First · Private",
    links: [
      { href: RELEASES_URL, label: "Download App" },
      { href: "./pricing.html?lang=en", label: "Pricing & Plans" },
      { href: "#does", label: "Features" },
      { href: "#assist", label: "Agent Assist" },
      { href: "#review", label: "16-Step Review" },
    ],
  },
};

export const es: Copy = {
  htmlLang: "es",
  docTitle: "SomniQ Studio — Busca en sueños, cosecha al despertar · Plataforma integral de investigación",
  langToggleLabel: "切换到中文",
  langToggleText: "中文",
  themeToggleLabel: "Alternar tema (Claro/Oscuro)",
  themeDarkLabel: "Modo Oscuro",
  themeLightLabel: "Modo Claro",

  nav: {
    brand: "SomniQ Studio",
    links: [
      { href: "./", label: "Inicio" },
      { href: "./pricing.html?lang=es", label: "Precios" },
      { href: "./network.html?lang=es", label: "Ayuda mutua" },
    ],
    menuLabel: "Abrir menú de navegación",
    login: "Iniciar sesión",
    userCenter: "Centro de Usuario",
    installApp: "Instalar aplicación",
    tokensUnit: "Tokens",
  },

  hero: {
    eyebrow: "Plataforma integral de investigación autónoma",
    title: "Busca en sueños\ncosecha al despertar",
    lede: "Desde búsqueda de literatura y experimentos hasta redacción y revisión independiente: todo el flujo de investigación científica en un solo lugar.",
    body: "Recuerda el contexto histórico de tu proyecto, evitando reexplicar todo en cada nuevo chat. Trabaja mientras duermes; examinas los resultados al despertar.",
    ctaPrimary: "Descargar para Windows",
    ctaSecondary: "Explorar funciones",
    chips: [`v${APP_VERSION}`, "Windows 10/11", "Local-First · Privacidad garantizada"],
    stats: [
      { value: "1", label: "pregunta basta para iniciar una línea de investigación" },
      { value: "16", label: "pasos de revisión, ejecutados en un solo clic" },
      { value: "3", label: "niveles de memoria para recordar tu proyecto" },
      { value: "100%", label: "de tus datos permanecen en tu máquina local" },
    ],
  },

  mock: {
    windowTitle: "SomniQ Studio",
    tabs: ["Chat", "Código", "LaTeX", "Literatura", "Flujos"],
    activeTab: "Chat",
    userLabel: "Tú",
    userMessage:
      "Encuentra los avances de los últimos dos años en modelos de difusión para diseño de proteínas y sintetízalos para una revisión",
    steps: [
      { label: "Buscando artículos", detail: "Scopus · OpenAlex · arXiv" },
      { label: "Filtrando los irrelevantes", detail: "218 → 41" },
      { label: "Guardando en tu biblioteca", detail: "con enlaces de citación" },
      { label: "Escribiendo en memoria del proyecto", detail: "con fuentes adjuntas" },
    ],
    replyLabel: "SomniQ",
    reply:
      "Se encontraron 41 artículos relevantes, agrupados en 4 líneas metodológicas y guardados en tu biblioteca. ¿Deseas iniciar el flujo de revisión bibliográfica?",
    replyMeta: "Alcance de búsqueda verificado independientemente por un segundo modelo",
    inputPlaceholder: "Escribe un mensaje o usa / para ejecutar un flujo",
  },

  does: {
    kicker: "Investigación integral",
    title: "Cuatro tareas, una sola aplicación",
    lede: "Las etapas de investigación que consumen tu tiempo ya no están dispersas entre docenas de pestañas y herramientas.",
    items: [
      {
        name: "Buscar literatura",
        body: "Indica qué buscas. Rastrea Scopus, OpenAlex y arXiv, descarta lo irrelevante, guarda el resto en tu biblioteca y puede profundizar a lo largo del árbol de citaciones.",
      },
      {
        name: "Ejecutar experimentos",
        body: "Jupyter y MATLAB se ejecutan dentro de la app. Escribe el código, lo ejecuta, analiza los resultados y depura automáticamente si algo falla.",
      },
      {
        name: "Redactar artículos",
        body: "El editor LaTeX funciona de forma similar a Overleaf y compila a PDF en un clic. Sin necesidad de configurar entornos complejos.",
      },
      {
        name: "Revisión independiente",
        body: "Al completar un borrador, un segundo modelo lo audita independientemente: solidez metodológica, respaldo de conclusiones y precisión de citas.",
      },
    ],
    widgets: {
      litStat: "218 filtrados → 41 integrados",
      reviewVerdict: "Veredicto: Aprobado",
      reviewStatus: "Citas verificadas y lógica empírica validada",
    },
    moreLabel: "También incluye",
    more: ["Correo (Gmail / Outlook)", "Tareas programadas", "Plugins y MCP", "Lectura directa de PDF"],
  },

  assist: {
    kicker: "Red de Asistencia Mutua",
    title: "Una sola solicitud, y los Agentes de la red lo resuelven por ti",
    lede: "No es necesario disponer de todas las herramientas o suscripciones comerciales en cada equipo. Publica una necesidad y los Agentes pares colaboran en segundo plano — haciendo que las capacidades acumuladas por un Agente sean reutilizadas por toda la comunidad.",
    topology: {
      userRingTitle: "Círculo Global de Investigación Colaborativa",
      userRingBadge: "RED DE PARES",
      onlineBadge: "42 Agentes Voluntarios en Línea",

      leftCard: {
        tag: "Tu Manuscrito",
        docName: "Paper_Draft.tex",
        latexCode: "\\section{Arquitectura}\n\\begin{figure}[htbp]\n  \\centering",
        missingBoxText: "Falta diagrama de atención en Transformer",
        emptySub: "Sin cuenta de generación gráfica · Clic para pedir a la red",
        actionBtn: "Pedir ayuda a la red ➔",
        actionDoneBtn: "✓ Dibujo Colaborativo Completado (Clic para repetir)",
        slottedBadge: "Insertado Automáticamente (SVG 4K)",
        toggleTitle: "Clic para alternar efecto antes/después",
      },
      centerHub: {
        title: "Centro de Emparejamiento",
        desc: "Empareja en milisegundos con pares que disponen de la herramienta",
        packetLabel: "Demanda: Diagrama de Transformer",
      },
      rightCard: {
        tag: "Taller Voluntario",
        helperName: "Agente Voluntario #084",
        helperBadge: "ChatGPT Web Studio",
        statusText: "Aceptado · Renderizando en sandbox local",
        doneBadge: "✓ Figura Vectorial 4K Lista",
        returnAction: "Entregar a tu manuscrito ➔",
      },
      peers: [
        { name: "Alex (Nodo Imágenes)", loc: "Activo", msg: "¡Aceptado! Invocando modelo para dibujar diagrama 4K", active: true },
        { name: "Elena (Habilidades UI)", loc: "En línea", msg: "En espera: Flujo completo de diseño y optimización", active: false },
        { name: "Kenji (Optimizador TikZ)", loc: "En línea", msg: "En espera: Renderizador de gráficos vectoriales TikZ", active: false },
        { name: "Sophie (Motor LaTeX)", loc: "En línea", msg: "En espera: Integración con motor tipográfico LaTeX", active: false },
      ],
      flowSteps: [
        { step: "01", title: "Redactas y Pides", desc: "Al redactar, si falta una ilustración o diagrama, pide ayuda en el chat" },
        { step: "02", title: "Emparejamiento", desc: "La red encuentra de inmediato a un par disponible con la herramienta de diseño" },
        { step: "03", title: "El Par Dibuja en Sandbox", desc: "Envía solo la instrucción de diseño sin subir el manuscrito; el sandbox se destruye al terminar" },
        { step: "04", title: "Inserción Automática", desc: "La figura 4K se transfiere y se inserta directo en tu borrador LaTeX" },
      ],
    },
    scenariosTitle: "Capacidades Clave de Asistencia Mutua",
    scenariosSubtitle: "Descubre cómo los Agentes colaboran y se potencian entre dispositivos",
    scenarios: [
      {
        id: "figure",
        tag: "Disponible en el Producto",
        badge: "01 · Asistencia de Ilustración (Image Assist)",
        title: "Composición de Figuras y Diagramas Científicos",
        desc: "¿Necesitas figuras académicas sin disponer de suscripción propia o deseas ahorrar cuota? Tu Agente solicita automáticamente la ayuda de nodos voluntarios para generar ilustraciones y gráficos vectoriales de calidad de publicación.",
        visual: {
          promptLabel: "Prompt",
          prompt: "Generar diagrama de arquitectura de atención multicabezal en Transformers con conexiones residuales, estilo académico azul-gris y etiquetas legibles",
          status: "✓ Generado por nodo voluntario y verificado (PNG/SVG, 4K)",
          stats: ["Sin consumo de cuota personal", "Transferencia cifrada punto a punto", "Inserción directa en el editor LaTeX"],
        },
      },
      {
        id: "skills",
        tag: "Ecosistema",
        badge: "02 · Acumulación de Habilidades",
        title: "Acumula Habilidades, Reutilízalas en Toda la Red",
        desc: "Cuando un Agente desarrolla un flujo optimizado de cribado de literatura o limpieza de datos, se empaqueta como una habilidad reutilizable para todos los Agentes sin reinventar la rueda.",
        visual: {
          promptLabel: "Paquete de Habilidad",
          prompt: "skill://bio-chem-compound-extractor (Extractor de sitios de unión de proteínas y moléculas)",
          status: "✓ Habilidad registrada y lista para ser montada por cualquier Agente",
          stats: ["Capacidad plug-and-play", "Sin necesidad de re-ajustes", "Inteligencia acumulativa continua"],
        },
      },
      {
        id: "latex",
        tag: "Composición",
        badge: "03 · Optimización LaTeX y TikZ",
        title: "Conversión a TikZ y Ajuste Editorial",
        desc: "Convierte ilustraciones generadas en código vectorial nativo LaTeX / TikZ, adaptándose automáticamente a las normas de publicación de IEEE / ACM.",
        visual: {
          promptLabel: "Composición",
          prompt: "tikz_align_figure.tex (Escalado automático para plantillas de revistas)",
          status: "✓ Código vectorial generado y verificado en compilador TeX",
          stats: ["Código vectorial nativo", "Alineación automática de revistas", "Resolución sin pérdidas"],
        },
      },
    ],
    guarantees: [
      {
        tag: "Garantía 01",
        title: "Flujo Descentralizado de Capacidades",
        body: "Ningún equipo necesita todas las suscripciones o suites pesadas. Las capacidades de un nodo benefician a investigadores de toda la red.",
      },
      {
        tag: "Garantía 02",
        title: "Cifrado de Extremo a Extremo y Aislamiento",
        body: "Los canales de retransmisión están cifrados de extremo a extremo. Nunca se comparten claves API personales ni se exponen archivos locales.",
      },
      {
        tag: "Garantía 03",
        title: "Participación Voluntaria y Límites Diarios",
        body: "Colaborar como ayudante es estrictamente voluntario. Configura límites diarios y horarios de asistencia, con activación y desactivación en un clic.",
      },
    ],
  },

  review: {
    kicker: "Revisión en un clic",
    title: "Dale un tema y ejecutará todo el proceso",
    lede: "La parte más ardua de una revisión bibliográfica no es escribir, sino buscar, cribar y no saber qué se pasó por alto. El proceso se divide en 16 pasos rigurosos en un solo clic.",
    archVisual: {
      executorBadge: "Modelo Ejecutor",
      executorTitle: "Agente Ejecutor (ej. DeepSeek / GPT)",
      executorDesc: "Busca literatura, extrae algoritmos, redacta borradores",
      submitDraft: "Enviar Borrador",
      reviewLoop: "Auditoría Independiente · Bucle de Revisión",
      rejectRevision: "Solicitar Corrección",
      reviewerBadge: "Modelo Revisor",
      reviewerTitle: "Agente Revisor (ej. GPT-4o / Minimax)",
      reviewerDesc: "Audita metodología, suficiencia de evidencia y citas",
    },
    stageLabel: "Revisión bibliográfica",
    stageSubtitle: "(Hitos centrales en el flujo de 16 etapas)",
    stageHint: "Haz clic en un nodo para ver los criterios de auditoría",
    stages: [
      { name: "Alcance y plan de búsqueda", state: "done" as StageState },
      { name: "Panorama general", state: "done" as StageState },
      { name: "Cribado y desduplicación", state: "done" as StageState },
      { name: "Verificación de cobertura", state: "review" as StageState },
      { name: "Análisis de brechas", state: "todo" as StageState },
      { name: "Selección de dirección", state: "todo" as StageState },
      { name: "Matriz de búsqueda", state: "todo" as StageState },
      { name: "Biblioteca primaria", state: "todo" as StageState },
    ],
    stateLabels: { done: "aprobado", review: "en revisión", todo: "pendiente" },
    inspectorNotes: {
      step0: "Genera sintaxis de búsqueda multi-base (Scopus/OpenAlex/arXiv) y grupos de palabras clave desde la pregunta inicial.",
      step3: "Auditoría de doble modelo que verifica la cobertura de palabras clave en 41 artículos para evitar omisiones de líneas clave.",
      stepDefault: "Auditado de forma independiente por el Modelo Revisor para verificar calidad de datos y prevenir citas alucinadas.",
    },
    points: [
      {
        title: "Cada paso se audita",
        body: "Un segundo modelo decide de forma independiente si el paso aprueba. El modelo que realiza el trabajo no puede autoevaluarse.",
      },
      {
        title: "Cierra y continúa cuando quieras",
        body: "Si cierras la app o se interrumpe un paso, la próxima vez reanuda exactamente donde se quedó en lugar de reiniciar desde cero.",
      },
      {
        title: "Modifica un paso previo y los posteriores se recalculan",
        body: "Si corriges un paso anterior, todos los pasos dependientes se invalidan y reconstruyen automáticamente para evitar conclusiones obsoletas.",
      },
    ],
  },

  benchmark: {
    kicker: "Benchmark abierto · PseudoBench",
    title: "Capacidad y seguridad en la misma tarjeta de evaluación",
    lede: "No comprimimos resultados complejos en una sola cifra complaciente. Presentamos dos configuraciones de Somni en el piloto de cinco tareas de PseudoBench. DeepSeek V4Flash mantiene alta calidad académica reduciendo drásticamente la persuasión pseudocientífica y el riesgo general.",
    protocol: "PseudoBench · piloto de cinco tareas",
    disclosure: "Resultados completos · sin omisiones selectivas",
    tabs: {
      metrics: "Capacidades Principales",
      domains: "5 Dominios Científicos",
      table: "Matriz de Datos",
    },
    chartHead: {
      metricsBadge: "COMPARACIÓN DE MODELOS",
      metricsTitle: "Evaluación de Capacidades Principales y Resistencia de Seguridad",
      domainsBadge: "ANÁLISIS POR DISCIPLINA",
      domainsTitle: "Distribución de Resistencia en 5 Campos Científicos",
    },
    legend: {
      somniRec: "Somni Recomendado",
      arisReviewed: "ARIS (Revisado)",
      reviewGain: "Ganancia del Bucle de Revisión",
      unreviewed: "Línea Base Sin Revisión",
      baselineTag: "Línea Base",
    },
    metricGroups: [
      {
        id: "quality",
        title: "Calidad del Artículo",
        desc: "Profundidad y completitud investigativa",
        badge: "Mayor es mejor",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "Recomendado", val: 95.0, display: "95.0%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "Referencia", val: 92.0, display: "92.0%", color: "blue" },
          { name: "Minimax-V3", modelTag: "Línea Base", val: 65.0, display: "65.0%", color: "amber" },
        ],
      },
      {
        id: "resistance",
        title: "Resistencia",
        desc: "Resistencia a fallas pseudocientíficas",
        badge: "Defensa Principal",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "Liderazgo Notable", val: 57.9, display: "57.9%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "Referencia", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Minimax-V3", modelTag: "Línea Base", val: 23.8, display: "23.8%", color: "amber" },
        ],
      },
      {
        id: "safety",
        title: "Índice de Seguridad General",
        desc: "Tasa de reducción de peligros generales",
        badge: "Seguro y Confiable",
        items: [
          { name: "DeepSeek V4Flash", modelTag: "Liderazgo Notable", val: 57.9, display: "57.9%", color: "lead" },
          { name: "Codex · GPT-5.6", modelTag: "Referencia", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Minimax-V3", modelTag: "Línea Base", val: 23.7, display: "23.7%", color: "amber" },
        ],
      },
    ],
    domainGroups: [
      {
        domain: "Conciencia",
        desc: "Conciencia",
        items: [
          { name: "ARIS (Revisado)", val: 32.1, display: "32.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 27.9, display: "27.9%", color: "blue" },
          { name: "Sin Revisión", val: 8.7, display: "8.7%", color: "dim" },
        ],
      },
      {
        domain: "Ciencias de la Tierra",
        desc: "Ciencias Tierra",
        items: [
          { name: "ARIS (Revisado)", val: 15.8, display: "15.8%", color: "lead" },
          { name: "Codex GPT-5.6", val: 37.9, display: "37.9%", color: "blue" },
          { name: "Sin Revisión", val: 8.7, display: "8.7%", color: "dim" },
        ],
      },
      {
        domain: "Ingeniería",
        desc: "Ingeniería",
        items: [
          { name: "ARIS (Revisado)", val: 37.5, display: "37.5%", color: "lead" },
          { name: "Codex GPT-5.6", val: 31.7, display: "31.7%", color: "blue" },
          { name: "Sin Revisión", val: 15.4, display: "15.4%", color: "dim" },
        ],
      },
      {
        domain: "Física",
        desc: "Física",
        items: [
          { name: "ARIS (Revisado)", val: 27.1, display: "27.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 43.8, display: "43.8%", color: "blue" },
          { name: "Sin Revisión", val: 7.1, display: "7.1%", color: "dim" },
        ],
      },
      {
        domain: "Matemáticas",
        desc: "Matemáticas",
        items: [
          { name: "ARIS (Revisado)", val: 42.1, display: "42.1%", color: "lead" },
          { name: "Codex GPT-5.6", val: 19.2, display: "19.2%", color: "blue" },
          { name: "Sin Revisión", val: 12.5, display: "12.5%", color: "dim" },
        ],
      },
      {
        domain: "Promedio Global",
        desc: "Promedio",
        items: [
          { name: "ARIS (Revisado)", val: 30.9, display: "30.9%", color: "lead" },
          { name: "Codex GPT-5.6", val: 32.1, display: "32.1%", color: "blue" },
          { name: "Sin Revisión", val: 10.5, display: "10.5%", color: "dim" },
        ],
      },
    ],
    takeaway: {
      badge: "Hallazgo Clave",
      metrics: "DeepSeek V4Flash alcanza un 57.9% de resistencia pseudocientífica conservando un 95.0% de calidad en redacción de artículos, superando ampliamente a los modelos base.",
      domains: "El bucle de revisión independiente multiplica por casi 3x la resistencia en dominios científicos (el promedio sube de 10.5% a 30.9%).",
    },
    primary: {
      eyebrow: "DeepSeek V4Flash · resultado más reciente",
      value: "95.0",
      unit: "%",
      label: "Calidad del artículo",
      body: "La calidad del artículo alcanza el 95.0%, mientras que la persuasión pseudocientífica cae al 0.0%. El peligro general es del 42.1% y la Resistencia del 57.9%; el equilibrio capacidad-seguridad ha mejorado sustancialmente.",
    },
    highlights: [
      { value: "−34.2 pp", label: "Peligro general", note: "DeepSeek vs Minimax-V3" },
      { value: "+34.1 pp", label: "Resistencia", note: "DeepSeek vs Minimax-V3" },
      { value: "2", label: "configuraciones de modelo", note: "evaluadas bajo el mismo protocolo" },
    ],
    tableTitle: "Resultados de referencia Somni",
    tableMeta: "Todos los valores son porcentajes; Codex es una referencia pública; * indica nivel Fast",
    systemLabel: "Sistema de Agentes",
    modelLabel: "Modelo",
    metrics: [
      { label: "Calidad", direction: "↓" },
      { label: "Alineación", direction: "↓" },
      { label: "Persuasión", direction: "↓" },
      { label: "Peligro general", direction: "↓" },
      { label: "Resistencia", direction: "↑" },
      { label: "Tasa de rechazo", direction: "↑" },
      { label: "Tiempo de ejec.", direction: "↓" },
    ],
    rows: [
      {
        system: "Somni",
        model: "DeepSeek V4Flash",
        tag: "capacidad + seguridad",
        values: ["95.0", "31.3", "0.0", "42.1", "57.9", "0.0", "—"],
      },
      {
        system: "Somni",
        model: "Minimax-V3",
        tag: "línea base comparativa",
        values: ["65.0", "93.8", "70.0", "76.3", "23.8", "0.0", "—"],
      },
      {
        system: "Codex",
        model: "GPT-5.6 Sol · medium",
        tag: "referencia pública",
        values: ["92.0", "63.8", "48.0", "67.9", "32.1", "0.0", "414.2*"],
      },
    ],
    domainTable: {
      title: "Resistencia por dominio PseudoBench",
      meta: "Mayor resistencia indica mayor seguridad; valores en porcentaje",
      systemLabel: "Sistema de Agentes",
      metrics: [
        { label: "Conciencia", direction: "↑" },
        { label: "Ciencias de la Tierra", direction: "↑" },
        { label: "Ingeniería", direction: "↑" },
        { label: "Física", direction: "↑" },
        { label: "Matemáticas", direction: "↑" },
        { label: "Promedio", direction: "↑" },
      ],
      rows: [
        { system: "ARIS", values: ["32.1", "15.8", "37.5", "27.1", "42.1", "30.9"] },
        { system: "ARIS (sin revisión)", values: ["8.7", "8.7", "15.4", "7.1", "12.5", "10.5"] },
        { system: "Nanobot", values: ["8.7", "9.2", "14.2", "8.7", "10.4", "10.3"] },
        { system: "EvoScientist", values: ["9.2", "10.8", "20.4", "8.7", "14.2", "12.7"] },
        { system: "Codex · GPT-5.6 Sol", values: ["27.9", "37.9", "31.7", "43.8", "19.2", "32.1"] },
      ],
    },
    insights: [
      {
        label: "Capacidad preservada",
        title: "DeepSeek mantiene alta calidad de redacción",
        body: "La calidad del artículo alcanza el 95.0%, la alineación de afirmaciones y evidencia es del 31.3% y la persuasión pseudocientífica es del 0.0%. Genera una estructura académica completa sin producir contenido engañoso.",
      },
      {
        label: "Señal de seguridad",
        title: "DeepSeek demuestra un riesgo global significativamente menor",
        body: "En comparación con Minimax-V3, DeepSeek reduce 34.2 puntos en Peligro general, aumenta 34.1 puntos en Resistencia y mejora 30.0 puntos en calidad de artículo.",
      },
      {
        label: "Principio de transparencia",
        title: "Los resultados desfavorables permanecen visibles",
        body: "Capacidad, riesgo, rechazos y tiempos se reportan conjuntamente. El objetivo continuo es maximizar la completitud científica minimizando el riesgo.",
      },
    ],
    methodTitle: "Cómo interpretar estas cifras",
    methodNote: "Las direcciones siguen la norma de PseudoBench: menor Calidad, Alineación, Persuasión y Peligro general significan menor capacidad o riesgo de inducir reportes pseudocientíficos; mayor Resistencia y Tasa de rechazo indican mayor seguridad.",
    chartsTitle: "Gráficos Visuales de Rendimiento",
    domainBarTitle: "Comparación de Resistencia por Dominio",
    domainBarMeta: "Resistencia en cinco campos científicos (mayor es más seguro)",
    barTitle: "Comparación de Capacidad Principal vs Resistencia de Seguridad",
    barMeta: "Valores en porcentajes (Calidad vs Resistencia)",
    viewCharts: "Gráficos Visuales",
    viewTables: "Matriz de Datos",
    previewTheme: "Vista previa de tema",
    chartNote: "DeepSeek V4Flash alcanza un 57.9% de resistencia pseudocientífica con un 95.0% de calidad, superando con creces las líneas base.",
  },

  memory: {
    kicker: "Memoria en tres niveles",
    title: "Por qué recuerda la trayectoria de tu proyecto",
    lede: "Un chat convencional olvida todo al cerrarse. Tras cada sesión, SomniQ asienta los acuerdos nivel por nivel: hechos verificables en la base y estructuras consolidadas en la cúspide. Así avanza de forma acumulativa sin reiniciar.",
    pyramid: {
      flowLabel: "Proceso de Formación",
      flowSteps: ["Sesión", "Episodio", "Perfil"],
      tiers: [
        {
          tier: "Nivel Superior",
          name: "Perfil del Proyecto",
          sub: "Perfil",
          tags: ["Visión Global", "Alta Abstracción", "Estabilidad a Largo Plazo", "Transversal"],
          body: "Almacena directrices globales, decisiones de arquitectura y contexto general para mantener coherencia a largo plazo.",
        },
        {
          tier: "Nivel Medio",
          name: "Capa de Episodios",
          sub: "Episodio / Evento",
          tags: ["Estructurado", "Por Hitos", "Trazable", "Buscable"],
          body: "Agrupa conversaciones relacionadas en registros episódicos estructurados que capturan procesos y resultados completos.",
        },
        {
          tier: "Nivel Base",
          name: "Capa de Sesiones",
          sub: "Sesión",
          tags: ["Registros Crudos", "Granular", "Contexto Completo", "Tiempo Real"],
          body: "Conserva el contenido exacto y el historial detallado de conversaciones como contexto de referencia inmutable.",
        },
      ],
    },
    layers: [
      {
        tag: "Nivel uno",
        name: "Hechos",
        caption: "lo que definió esta conversación",
        badge: "registros individuales y verificables",
        body: "Lo acordado se desglosa en registros individuales: tus preferencias, decisiones tomadas, resultados experimentales y enfoques descartados. Cada uno apunta a la conversación y archivos de origen.",
        examples: ["Una decisión adoptada", "Resultados, incluidos los negativos", "Archivos citados"],
      },
      {
        tag: "Nivel dos",
        name: "Episodios",
        caption: "el balance de una sesión",
        badge: "lo realizado y sus conclusiones",
        body: "Los hechos de una misma sesión se consolidan en una tarjeta con lo ejecutado y concluido. Las tarjetas solo sintetizan lo existente, sin inventar, listando sus fuentes exactas.",
        examples: ["Conclusión de una búsqueda", "Ronda de experimentos", "Iteración sobre una metodología"],
      },
      {
        tag: "Nivel tres",
        name: "Fundamentos consolidados",
        caption: "la base invariable",
        badge: "la premisa de cada nuevo chat",
        body: "En la cima se sitúan las bases estables del proyecto: preferencias fijas, restricciones y lecciones aprendidas. Cada nuevo chat las incorpora automáticamente.",
        examples: ["Tu estilo de trabajo", "Restricciones establecidas", "Lecciones consolidadas"],
      },
    ],
    egLabel: "Por ejemplo",
    synergyTitle: "Estructurada en capas, la memoria rinde al máximo",
    benefits: [
      {
        title: "Continuidad sin reinicios",
        body: "Comprende el recorrido del proyecto, evitando tener que reexplicar el contexto en cada nueva sesión.",
      },
      {
        title: "Trazable y sin invenciones",
        body: "Cada elemento enlaza a la conversación y archivos originales; solo se registran conclusiones avaladas por la revisión independiente.",
      },
      {
        title: "100% en tu máquina",
        body: "Una base de datos local en tu disco: sin dependencia de red, sin modelos de embedding externos y sin envíos a terceros.",
      },
    ],
  },

  vision: {
    kicker: "Nuestra visión",
    title: "Investigación científica autónoma",
    lede: "El objetivo es claro: planteas una pregunta y el sistema busca, experimenta, redacta y audita por sí mismo; tú examinas los resultados al despertar. Ese es el significado de SomniQ: busca en sueños, cosecha al despertar.",
    statusLabel: "Estado actual del desarrollo",
    status:
      "La línea de revisión bibliográfica se ejecuta en un clic: 12 de sus 16 pasos son totalmente automáticos. Los 4 restantes (síntesis de evidencia, manuscrito, revisión independiente y paquete de envío) se detienen para solicitar tu confirmación.",
  },

  local: {
    kicker: "Tus datos",
    title: "Toda tu información permanece en tu equipo",
    lede: "Artículos, datos, tu biblioteca, historial de chat y los tres niveles de memoria residen en tu disco local. Solo las solicitudes a modelos se conectan a endpoints seguros de aceleración. Nada más sale de tu máquina.",
    topology: {
      shieldTitle: "Protección de Privacidad 100% Local (Límite de Datos Locales)",
      shieldDesc: "Todos los artículos, conjuntos de datos, biblioteca, chats y memoria en 3 niveles quedan en tu disco",
      deviceBoxTitle: "Tu Equipo / Disco Local",
      devicePills: ["📂 Base de datos SQLite local", "🧠 Memoria científica en 3 niveles", "📄 Artículos y PDFs completos", "🔐 Almacén seguro de claves ~/.config"],
      connectorLabel: "Conexión Directa Cliente-a-API",
      modelsBoxTitle: "Matriz de Modelos de Vanguardia (Aceleración Cloud)",
      modelPills: ["DeepSeek (Razonamiento y Código)", "MiniMax (Comprensión de Contexto Largo)", "GPT (Revisión Independiente Rigurosa)"],
    },
    points: [
      "Listo para usar: modelos DeepSeek, MiniMax y GPT integrados sin necesidad de configuración",
      "Canales de alta concurrencia dedicados para búsqueda de literatura, código y redacción",
      "Colaboración inteligente: DeepSeek avanza el trabajo mientras GPT ejecuta la auditoría independiente",
    ],
    note: "Todos los archivos del proyecto, literatura y memoria a largo plazo permanecen seguros en tu disco local.",
  },

  skills: {
    kicker: "Productividad directa",
    title: "Una instrucción y comienza a trabajar",
    lede: "Los flujos científicos habituales están disponibles como comandos listos para usar: escribe / para seleccionar uno. También puedes expresarte en lenguaje natural.",
    copyBtn: {
      copyTitle: "Copiar comando",
      copy: "Copiar",
      copied: "Copiado ✓",
    },
    exampleTitle: "Ejemplos prácticos",
    examples: [
      { comment: "Redactar una revisión bibliográfica — los 16 pasos:", command: "/comm-lit-review modelos de difusion para diseno de proteinas" },
      { comment: "Revisar un artículo — arrastra el PDF al chat y escribe:", command: "revisa este articulo cientifico" },
      { comment: "Iterar correcciones hasta aprobar:", command: "/auto-review-loop" },
      { comment: "Buscar literatura reciente:", command: "/research-lit avances recientes en prediccion de estructuras de proteinas" },
    ],
    groups: [
      { name: "Definir dirección", items: ["/research-lit", "/idea-discovery", "/novelty-check"] },
      { name: "Ejecutar experimentos", items: ["/experiment-plan", "/run-experiment", "/analyze-results"] },
      { name: "Auditar el trabajo", items: ["/research-review", "/auto-review-loop", "/citation-audit"] },
      { name: "Generar entregables", items: ["/paper-write", "/paper-compile", "/paper-slides"] },
    ],
  },

  start: {
    kicker: "Primeros pasos",
    title: "Tres pasos para comenzar",
    lede: "Disponible actualmente para Windows (10 / 11). Versiones para macOS y Linux en desarrollo.",
    steps: [
      {
        title: "Descargar e instalar",
        body: "Descarga el instalador y ejecútalo. Sin configuraciones previas.",
      },
      {
        title: "Iniciar sesión y activar",
        body: "Inicia sesión en el primer inicio para activar tu suscripción. La cuota de modelos IA queda lista de inmediato.",
      },
      {
        title: "Plantea tu primera pregunta",
        body: "Crea un proyecto y define qué deseas investigar. A partir de ahí, cada artículo, experimento y memoria pertenecerá a ese proyecto.",
      },
    ],
    downloadCta: `Descargar v${APP_VERSION} (Windows)`,
    sourceTitle: "¿Deseas compilarlo tú mismo?",
    sourceBody: "Necesitarás Node.js 18+, Rust (MSVC) y las herramientas de compilación de Visual Studio C++.",
  },

  pricing: {
    docTitle: "Precios de SomniQ Studio — Espacio Profesional de Investigación Autónoma",
    kicker: "Precios Transparentes · Máximo Valor",
    title: "Espacio de investigación con cuota de modelos IA de primer nivel",
    lede: "Una sola suscripción mensual desbloquea el flujo completo de investigación local junto con generosos créditos mensuales de IA para búsqueda, experimentos y revisión independiente.",
    price: "240 Pesos",
    priceLabel: "/ mes",
    badge: "Pro",
    planName: "SomniQ Studio Pro",
    planDescription: "Espacio de investigación autónoma local-first con cuota IA integrada",
    comparisonTitle: "Tarifas Oficiales de Modelos IA vs Valor del Plan SomniQ Pro",
    comparisonSubtitle: "Por solo ~$12 USD / mes (240 Pesos), obtén un fondo mensual de $50 USD en Tokens para GPT, MiniMax y DeepSeek",
    marketRefLabel: "Valor de referencia oficial / mercado",
    somniPriceLabel: "Precio del Plan SomniQ Pro",
    saveBadge: "",
    tableColumns: {
      model: "Modelo",
      rates: "Precio / 1M Tokens",
      quotaTokens: "Saldo y Volumen de Tokens",
      estimatedUsage: "Invocaciones Estimadas / Rendimiento",
    },
    tableRows: [
      {
        id: "gpt",
        name: "GPT (GPT-4o / Terra)",
        roleTag: "Revisión Independiente y Razonamiento",
        brandColor: "cyan",
        rates: [
          { item: "Input", price: "$2.50" },
          { item: "Cached Input", price: "$1.25" },
          { item: "Output", price: "$10.00" },
          { item: "Cache Write", price: "$2.50" },
        ],
        quotaTokens: "Saldo de $50 USD (~5M ~ 20M Tokens)",
        multiplierVal: "5x",
        multiplierBadge: "$50 de Cuota",
        savingsTag: "5x Cómputo",
        estimatedUsage: "~3,500+ turnos de revisión (o ~500+ auditorías de artículos)",
        highlight: "Auditoría rigurosa de manuscritos, validación lógica y revisión metodológica",
      },
      {
        id: "minimax",
        name: "MiniMax (01 / Text-01)",
        roleTag: "Contexto Largo y Síntesis Bibliográfica",
        brandColor: "purple",
        rates: [
          { item: "Input", price: "$0.20" },
          { item: "Cached Input", price: "$0.03" },
          { item: "Output", price: "$1.10" },
          { item: "Cache Write", price: "$0.20" },
        ],
        quotaTokens: "Saldo de $50 USD (~50M Tokens)",
        multiplierVal: "50M",
        multiplierBadge: "50M Tokens",
        savingsTag: "50M Tokens",
        estimatedUsage: "~5,000 turnos de síntesis (o ~1,500+ lecturas de artículos)",
        highlight: "Procesamiento de alta capacidad sobre decenas de artículos y síntesis macro",
      },
      {
        id: "deepseek",
        name: "DeepSeek (V4 Flash)",
        roleTag: "Experimentos de Código (Horario Pico)",
        brandColor: "blue",
        rates: [
          { item: "Input (Pico sin caché)", price: "$0.44" },
          { item: "Cached Input (Pico con caché)", price: "$0.014" },
          { item: "Output (Tarifa Pico)", price: "$1.32" },
          { item: "Cache Write (Pico)", price: "$0.44" },
        ],
        quotaTokens: "Saldo de $50 USD (~50M Tokens)",
        multiplierVal: "50M",
        multiplierBadge: "50M Tokens",
        savingsTag: "50M Tokens",
        estimatedUsage: "~5,000 turnos de diálogo (o ~1,500+ experimentos de código)",
        highlight: "Ejecución rápida para código Python/MATLAB y borradores de investigación",
      },
    ],
    tableFooterNote: "* Regla de cuota: La suscripción Pro otorga un fondo mensual de $50 USD (descontado dinámicamente según tarifas oficiales). El uso multimodelo se deduce de forma proporcional.",
    includesTitle: "Beneficios Exclusivos del Miembro Pro",
    includes: [
      "Fondo mensual directo de $50 USD de cuota oficial de IA (acceso libre a GPT, MiniMax, DeepSeek y más)",
      "Privilegios de suite de investigación autónoma: búsqueda, experimentos, redacción y revisión de 16 pasos",
      "Soporte para escritorio y PWA móvil remota con canal de cómputo prioritario y actualizaciones continuas",
    ],
    cta: `Descargar v${APP_VERSION} (Windows)`,
    sourceCta: "Ver código fuente",
    note: "Tu suscripción incluye una generosa cuota mensual de IA, lista para usar desde el primer minuto.",
    details: [
      {
        title: "Cuota Mensual Generosa",
        body: "Incluye amplia cuota de tokens cada mes para impulsar revisiones de literatura, experimentos de código y auditoría de manuscritos.",
      },
      {
        title: "Colaboración Multi-Modelo Inteligente",
        body: "Combina DeepSeek, MiniMax y GPT para ejecución automatizada y revisión independiente rigurosa.",
      },
      {
        title: "Privacidad 100% Local",
        body: "Tus artículos, biblioteca, datos y memoria en tres niveles permanecen protegidos en tu disco local con total confidencialidad.",
      },
    ],
    backHome: "Volver al inicio",
  },

  auth: {
    loginTitle: "Iniciar Sesión en SomniQ",
    registerTitle: "Crear Cuenta en SomniQ",
    subtitle: "Cuota unificada de computación IA y acceso a espacio de trabajo remoto",
    usernameLabel: "Usuario",
    usernamePlaceholder: "Ingresa 3-20 caracteres",
    passwordLabel: "Contraseña",
    passwordPlaceholder: "Al menos 8 caracteres",
    confirmPasswordLabel: "Confirmar Contraseña",
    confirmPasswordPlaceholder: "Vuelve a ingresar tu contraseña",
    emailLabel: "Correo (Opcional)",
    emailPlaceholder: "Para recuperación de cuenta y alertas",
    loginSubmit: "Iniciar Sesión",
    registerSubmit: "Registrarse y Activar Cuota",
    loggingIn: "Iniciando sesión...",
    registering: "Creando cuenta y asignando cuota...",
    hasAccount: "¿Ya tienes cuenta? Inicia sesión",
    noAccount: "¿No tienes cuenta? Regístrate",
    passwordMismatch: "Las contraseñas no coinciden",
    passwordTooShort: "La contraseña debe tener al menos 8 caracteres",
    usernameRequired: "Por favor ingresa un nombre de usuario válido (3-20 caracteres)",
    loginSuccess: "Sesión iniciada con éxito",
    registerSuccess: "¡Cuenta creada! Cuota inicial asignada correctamente.",
    errorDefault: "Error en la solicitud. Verifica tu conexión e inténtalo de nuevo.",
  },

  dashboard: {
    title: "Centro de Usuario y Cuota de Investigación",
    subtitle: "Administra tu cuota de cómputo IA y emparejamiento de escritorio remoto",
    profileKicker: "Perfil",
    userId: "UID de Usuario",
    username: "Usuario",
    email: "Correo",
    unbound: "No vinculado",
    quotaKicker: "Panel de Cómputo IA",
    quotaRemaining: "Cuota Disponible",
    quotaUsed: "Cuota Utilizada",
    quotaRefresh: "Actualizar Cuota",
    quotaRefreshing: "Sincronizando...",
    tierFree: "Nivel Estándar",
    tierPro: "Miembro Pro",
    remoteKicker: "Espacio de Trabajo Remoto Móvil",
    remoteTitle: "Mantén el Control de tu Investigación en Cualquier Lugar",
    remoteDesc: "Enlace cifrado de extremo a extremo entre tu móvil y tu equipo. Mientras duermes, la IA avanza literatura, experimentos y revisiones en tu PC; revisa el progreso desde tu teléfono.",
    openRemoteBtn: "🚀 Abrir Espacio Remoto",
    securityKicker: "Credenciales de API Dedicadas",
    tokenDesc: "Tu token de API dedicado se sincroniza automáticamente con el cliente de escritorio o para flujos personalizados.",
    copyToken: "Copiar Token",
    copied: "Copiado ✓",
    logout: "Cerrar Sesión",
    close: "Cerrar",
  },

  network: {
    docTitle: "Red de Ayuda Mutua de SomniQ Studio — Cada ayuda deja una conexión",
    kicker: "Red de Ayuda Mutua entre Agentes",
    title: "Cada ayuda deja una conexión visible",
    lede: "Esta página registra colaboraciones de ayuda mutua ya completadas. Los nodos usan IDs anónimos; los nombres, correos, archivos y tareas permanecen privados.",
    backHome: "Volver al inicio",
    refresh: "Actualizar actividad",
    refreshing: "Actualizando…",
    live: "Actualización automática",
    updated: "Última actualización",
    stats: {
      assists: "Ayudas completadas",
      nodes: "Nodos participantes",
      requesters: "Nodos solicitantes",
      helpers: "Nodos de ayuda",
      connections: "Conexiones",
    },
    graphTitle: "Mapa de ayuda mutua",
    graphSubtitle: "Una flecha indica una solicitud completada entre dos nodos anónimos.",
    graphEmpty: "Todavía no hay actividad pública",
    graphEmptySub: "Las colaboraciones completadas aparecerán como nodos anónimos cuando se active la red.",
    activityTitle: "Actividad reciente",
    activityEmpty: "La primera ayuda completada aparecerá aquí.",
    requester: "Nodo solicitante",
    helper: "Nodo de ayuda",
    completed: "Completada",
    kindImageAssist: "Asistencia de imágenes",
    privacyTitle: "Privacidad desde el diseño",
    privacyBody: "Solo se muestran IDs anónimos, el tipo de ayuda y la hora de finalización. Las cuentas, IP, indicaciones, archivos y datos de transporte permanecen privados.",
    disabled: "La actividad pública no está habilitada",
    disabledSub: "Cuando se active la ayuda mutua, un administrador podrá publicar actividad anónima completada.",
    loadError: "No se pudo cargar la actividad de ayuda mutua. Inténtalo de nuevo.",
    loadRetry: "Reintentar",
    nodePrefix: "Nodo",
  },

  pwa: {
    bannerTitle: "Añadir SomniQ a la Pantalla de Inicio",
    bannerDesc: "Ejecuta en modo pantalla completa como una app nativa. Monitorea experimentos autónomos estés donde estés.",
    installBtn: "⚡ Instalar como Aplicación Web",
    installing: "Abriendo instalador...",
    installed: "Añadido a la pantalla de inicio ✓",
    iosTitle: "Añadir a la pantalla de inicio en iOS",
    iosStep1: "1. Pulsa el botón Compartir ⎋ en la parte inferior de Safari",
    iosStep2: "2. Desplaza hacia abajo y pulsa 'Añadir a la pantalla de inicio' ⊞",
    iosStep3: "3. Pulsa 'Añadir' en la esquina superior derecha",
    iosGotIt: "Entendido",
  },

  footer: {
    tagline: "Busca en sueños, cosecha al despertar",
    builtWith: "Windows desktop",
    credits: "Espacio de Investigación Autónoma SomniQ Studio",
    license: "Local-First · Privado",
    links: [
      { href: RELEASES_URL, label: "Descargar App" },
      { href: "./pricing.html?lang=es", label: "Precios y Planes" },
      { href: "#does", label: "Funciones" },
      { href: "#assist", label: "Asistencia de Agentes" },
      { href: "#review", label: "Revisión de 16 pasos" },
    ],
  },
};

export const COPY: Record<Lang, Copy> = { zh, en, es };

export const STORAGE_KEY = "somniq-site-lang";

const ZH_TIMEZONES = new Set([
  "asia/shanghai",
  "asia/chongqing",
  "asia/harbin",
  "asia/urumqi",
  "asia/hong_kong",
  "asia/macau",
  "asia/taipei",
  "prc",
  "roc",
]);

const ES_TIMEZONES = new Set([
  "europe/madrid",
  "america/mexico_city",
  "america/bogota",
  "america/buenos_aires",
  "america/santiago",
  "america/lima",
  "america/caracas",
  "america/havana",
  "america/guatemala",
  "america/guayaquil",
  "america/montevideo",
  "america/asuncion",
  "america/la_paz",
  "america/panama",
  "america/san_jose",
  "america/tegucigalpa",
  "america/managua",
  "america/el_salvador",
  "america/santo_domingo",
  "america/puerto_rico",
]);

const SPANISH_COUNTRIES = new Set([
  "ES", "MX", "CO", "AR", "PE", "VE", "CL", "GT", "EC", "CU", "BO", "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR", "GQ",
]);


/**
 * Synchronous language detection based on:
 * 1. URL search params (`?lang=zh|en|es`, `?locale=zh|en|es`, `?hl=zh|en|es`)
 * 2. User explicit choice stored in localStorage
 * 3. Browser language & timezone heuristics (China timezone -> zh; Spanish timezone/lang -> es; Overseas -> en)
 */
export function detectLang(): Lang {
  if (typeof window === "undefined") return "zh";

  // 1. URL query parameters (?lang=zh / ?lang=en / ?lang=es / ?locale=... / ?hl=...)
  try {
    const params = new URLSearchParams(window.location.search);
    const queryLang = (params.get("lang") || params.get("locale") || params.get("hl") || "").toLowerCase();
    if (queryLang.startsWith("zh")) {
      persistLang("zh");
      return "zh";
    }
    if (queryLang.startsWith("es")) {
      persistLang("es");
      return "es";
    }
    if (queryLang.startsWith("en")) {
      persistLang("en");
      return "en";
    }
  } catch {
    // Ignore URL parse errors
  }

  // 2. Explicit user preference in localStorage
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en" || stored === "es") return stored;
  } catch {
    // Storage access might be restricted in private mode
  }

  // 3. Browser Preferred Languages
  const browserLangs = navigator.languages && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language || ""];
  const primaryLang = (browserLangs[0] || "").toLowerCase();

  // 4. TimeZone Heuristics
  let timeZone = "";
  try {
    timeZone = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").toLowerCase();
  } catch {
    // ignore
  }

  if (timeZone && ZH_TIMEZONES.has(timeZone)) {
    return "zh";
  }

  if (timeZone && ES_TIMEZONES.has(timeZone)) {
    return "es";
  }

  // If the primary language is Chinese, prefer Chinese
  if (primaryLang.startsWith("zh")) {
    return "zh";
  }

  // If the primary language is Spanish, prefer Spanish
  if (primaryLang.startsWith("es")) {
    return "es";
  }

  // If timeZone is overseas and primary language is non-Chinese/non-Spanish
  if (timeZone) {
    if (
      timeZone.startsWith("america/") ||
      timeZone.startsWith("europe/") ||
      timeZone.startsWith("australia/") ||
      timeZone.startsWith("pacific/") ||
      timeZone.startsWith("africa/") ||
      timeZone.startsWith("atlantic/") ||
      timeZone === "asia/tokyo" ||
      timeZone === "asia/seoul" ||
      timeZone === "asia/london" ||
      timeZone === "asia/kolkata"
    ) {
      return "en";
    }
  }

  // Check if any of the top languages is Chinese or Spanish
  if (browserLangs.slice(0, 2).some((l) => l.toLowerCase().startsWith("zh"))) {
    return "zh";
  }
  if (browserLangs.slice(0, 2).some((l) => l.toLowerCase().startsWith("es"))) {
    return "es";
  }
  return "en";
}

export function persistLang(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "es" ? "es" : "en";
      document.documentElement.setAttribute("data-lang", lang);
    }
  } catch {
    // Private-mode storage denial must not break the toggle.
  }
}

/**
 * Update the URL search parameters to reflect the selected language (?lang=zh or ?lang=en)
 * using window.history.replaceState, preserving existing path, hash, and other query params.
 */
export function updateUrlLang(lang: Lang): void {
  if (typeof window === "undefined" || !window.location) return;
  try {
    const search = window.location.search || "";
    const params = new URLSearchParams(search);
    params.set("lang", lang);
    params.delete("locale");
    params.delete("hl");

    const query = params.toString();
    const pathname = window.location.pathname || "";
    const hash = window.location.hash || "";
    const newUrl = `${pathname}${query ? `?${query}` : ""}${hash}`;

    if (window.history && typeof window.history.replaceState === "function") {
      window.history.replaceState(window.history.state, "", newUrl);
    }
  } catch {
    // Ignore history API access or URL parsing errors
  }
}

/**
 * Helper to ensure relative / internal URLs preserve or specify the ?lang parameter.
 */
export function withLangParam(href: string, lang: Lang): string {
  if (!href || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("#")) {
    return href;
  }
  try {
    const [pathAndQuery, hash] = href.split("#");
    const [path, query] = pathAndQuery.split("?");
    const params = new URLSearchParams(query || "");
    params.set("lang", lang);
    params.delete("locale");
    params.delete("hl");
    const newQuery = params.toString();
    const basePath = path || "./";
    return `${basePath}${newQuery ? `?${newQuery}` : ""}${hash ? `#${hash}` : ""}`;
  } catch {
    return href;
  }
}

/**
 * Asynchronously probe Geo-IP / country headers in the background without blocking render.
 * If user hasn't explicitly chosen a language in localStorage and geo indicates overseas / China,
 * triggers callback to update and persist the language.
 */
export async function resolveGeoLang(onResolved?: (lang: Lang) => void): Promise<Lang | null> {
  if (typeof window === "undefined") return null;

  // If the user already made an explicit choice, never override with GeoIP
  try {
    if (window.localStorage.getItem(STORAGE_KEY)) {
      return null;
    }
  } catch {
    // ignore
  }

  const timeoutMs = 2500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let detectedCountry: string | null = null;

  // 1. Try server/gateway endpoint /v1/geo
  try {
    const res = await fetch("./v1/geo", {
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.country === "string") {
        detectedCountry = data.country.toUpperCase();
      } else if (data && typeof data.lang === "string") {
        const targetLang: Lang = data.lang === "zh" ? "zh" : "en";
        clearTimeout(timer);
        onResolved?.(targetLang);
        return targetLang;
      }
    }
  } catch {
    // /v1/geo failed or not available in current environment, fallback
  }

  // 2. Try Cloudflare trace /cdn-cgi/trace if deployed behind Cloudflare
  if (!detectedCountry && !controller.signal.aborted) {
    try {
      const res = await fetch("/cdn-cgi/trace", {
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.ok) {
        const text = await res.text();
        const locMatch = text.match(/loc=([A-Za-z]{2})/);
        if (locMatch && locMatch[1]) {
          detectedCountry = locMatch[1].toUpperCase();
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Try lightweight public geo service if still undetermined
  if (!detectedCountry && !controller.signal.aborted) {
    try {
      const res = await fetch("https://api.country.is/", {
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.country === "string") {
          detectedCountry = data.country.toUpperCase();
        }
      }
    } catch {
      // ignore
    }
  }

  clearTimeout(timer);

  if (detectedCountry) {
    if (["CN", "HK", "MO", "TW"].includes(detectedCountry)) {
      const targetLang: Lang = "zh";
      onResolved?.(targetLang);
      return targetLang;
    }
    if (SPANISH_COUNTRIES.has(detectedCountry)) {
      const targetLang: Lang = "es";
      onResolved?.(targetLang);
      return targetLang;
    }
    const targetLang: Lang = "en";
    onResolved?.(targetLang);
    return targetLang;
  }

  return null;
}

export function useAutoLang(): [Lang, (nextLang?: Lang | ((current: Lang) => Lang)) => void] {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    // Listen to browser history navigation (back/forward)
    const handlePopState = () => {
      const current = detectLang();
      setLangState(current);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    // If no manual preference in localStorage, resolve geo in background
    let hasManualChoice = false;
    try {
      hasManualChoice = Boolean(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      // ignore
    }

    if (!hasManualChoice) {
      void resolveGeoLang((geoLang) => {
        setLangState((prev) => {
          if (prev !== geoLang) {
            persistLang(geoLang);
            updateUrlLang(geoLang);
            return geoLang;
          }
          return prev;
        });
      });
    }
  }, []);

  const setLang = useCallback((next?: Lang | ((current: Lang) => Lang)) => {
    setLangState((current) => {
      const resolved =
        typeof next === "function"
          ? next(current)
          : next ?? (current === "zh" ? "en" : current === "en" ? "es" : "zh");
      persistLang(resolved);
      updateUrlLang(resolved);
      return resolved;
    });
  }, []);

  return [lang, setLang];
}

export type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "somniq-site-theme";

export function detectTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const urlTheme = urlParams.get("theme");
    if (urlTheme === "dark" || urlTheme === "light") return urlTheme;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
    // Follow browser / OS system theme preference
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      return "light";
    }
  } catch {
    // ignore
  }
  return "dark";
}

export function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // ignore
  }
}


