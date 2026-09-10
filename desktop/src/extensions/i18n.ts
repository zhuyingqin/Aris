import type { Language } from "../store";
import type {
  PptMasterCheck,
  PptMasterError,
  PptMasterErrorCode,
} from "../types";

export const EXTENSIONS_COPY: Record<Language, {
  title: string;
  subtitle: string;
  tabsAriaLabel: string;
  pluginsTab: string;
  skillsTab: string;
  desktopOnlyPrefix: string;
  desktopOnlySuffix: string;
  loadingMcp: string;
  loadingSkillContent: string;
  connectedHeading: string;
  configuredHeading: string;
  configuredSubtitle: string;
  testAll: string;
  verified: string;
  failed: string;
  ready: string;
  needsSetup: string;
  notTested: string;
  available: string;
  unavailable: string;
  bundledInstallPath: string;
  noConnectedPlugins: string;
  addCustomMcp: string;
  recommended: string;
  added: string;
  add: string;
  skillsHeading: string;
  skillsSubtitle: string;
  noSkillsFound: string;
  managedSkillsHeading: string;
  managedSkillsSubtitle: string;
  pptMasterDescription: string;
  openPptPreview: string;
  installPptMaster: string;
  updatePptMaster: string;
  repairPptMaster: string;
  removePptMaster: string;
  installingPptMaster: string;
  removingPptMaster: string;
  pptMasterReady: string;
  pptMasterNeedsRepair: string;
  pptMasterUnmanaged: string;
  pptMasterVersion: (version: string) => string;
  removePptMasterConfirm: string;
  /** One sentence per backend error code. Kept exhaustive by the Rust test
   *  `installer_error_codes_are_exhaustive`. */
  pptMasterErrors: Record<PptMasterErrorCode, (params: Record<string, string>) => string>;
  pptMasterChecks: Record<string, string>;
  pptMasterEvidence: string;
  pptMasterFixOpenUrl: string;
  pptMasterFixRevealPath: string;
  pptMasterFixRetry: string;
  argumentHintPrefix: (hint: string) => string;
  view: string;
  skillDetailsAria: string;
  pathLabel: string;
  argumentsMetaLabel: string;
  toolsMetaLabel: string;
  selectASkill: string;
  selectSkillHint: string;
  closeAria: string;
  mcpDetailsAria: string;
  globalStdio: string;
  globalConfigPath: string;
  newMcpFallbackName: string;
  editable: string;
  readonly: string;
  checkingTools: string;
  testTools: string;
  delete: string;
  runtimeStatusHint: (testToolsLabel: string) => string;
  toolsLoadedOk: string;
  toolsLoadedFailed: string;
  nameLabel: string;
  commandLabel: string;
  argsPerLineLabel: string;
  envVarsLabel: string;
  timeoutSecondsLabel: string;
  saving: string;
  addMcp: string;
  saveSettings: string;
  saved: string;
  saveBeforeTest: string;
  unsavedTestHint: string;
  cancel: string;
  reloadNote: string;
  sourceLabelHeading: string;
  connectionTypeLabel: string;
  viewOnlyNote: string;
  managedOracleNote: string;
  managedReady: string;
  managedUnavailable: string;
  installOracle: string;
  updateOracle: string;
  installingOracle: string;
  oracleSettings: string;
  sourceLabels: {
    project: string;
    user: string;
    local: string;
    global: string;
    managed: string;
  };
  skillSourceBundled: string;
  skillSourceLocal: string;
  catalog: {
    codexDescription: string;
    claudeDescription: string;
    playwrightDescription: string;
  };
}> = {
  cn: {
    title: "插件",
    subtitle: "集中管理 MCP、ChatGPT 网页账号与本地技能。配置保存在账号级全局目录。",
    tabsAriaLabel: "插件与技能",
    pluginsTab: "MCP",
    skillsTab: "技能",
    desktopOnlyPrefix: "插件与技能需要桌面端支持。运行 ",
    desktopOnlySuffix: "。",
    loadingMcp: "正在读取 MCP...",
    loadingSkillContent: "正在读取 SKILL.md…",
    connectedHeading: "MCP 服务",
    configuredHeading: "已配置的 MCP",
    configuredSubtitle: "状态只表示配置或运行时情况；验证后才代表工具实际可用。",
    testAll: "验证全部",
    verified: "已验证",
    failed: "验证失败",
    ready: "运行时就绪",
    needsSetup: "需要设置",
    notTested: "未验证",
    available: "本机可用",
    unavailable: "本机不可用",
    bundledInstallPath: "内置路径",
    noConnectedPlugins: "还没有连接任何 MCP 插件",
    addCustomMcp: "添加自定义 MCP",
    recommended: "推荐",
    added: "已添加",
    add: "添加",
    skillsHeading: "技能",
    skillsSubtitle: "点击一个技能查看说明、路径和完整 SKILL.md。",
    noSkillsFound: "未发现可用技能",
    managedSkillsHeading: "受管技能",
    managedSkillsSubtitle: "由 SomniQ 固定版本、隔离运行时并显式管理更新。",
    pptMasterDescription: "生成、重构和编辑原生可修改的 PPTX，并提供 SVG 逐页预览。",
    openPptPreview: "幻灯片预览",
    installPptMaster: "安装",
    updatePptMaster: "更新",
    repairPptMaster: "修复运行时",
    removePptMaster: "卸载",
    installingPptMaster: "正在安装依赖…",
    removingPptMaster: "正在卸载…",
    pptMasterReady: "Skill 与独立 Python 环境已就绪",
    pptMasterNeedsRepair: "Python 环境不完整",
    pptMasterUnmanaged: "检测到同名本地 Skill，SomniQ 不会覆盖",
    pptMasterVersion: (version) => `固定版本 v${version}`,
    removePptMasterConfirm: "卸载 SomniQ 管理的 PPT Master 及其独立 Python 环境？",
    pptMasterErrors: {
      unmanaged: (p) => `检测到来自其他来源的 ppt-master 技能（${p.path ?? "路径未知"}），SomniQ 不会覆盖或删除它。请先移走它再安装。`,
      pythonMissing: (p) => `找不到 Python 解释器（在 PATH 中查找 ${p.command ?? "python"}）。安装 Python 后重试，或用 SOMNIQ_PYTHON 环境变量指定路径。`,
      venvFailed: (p) =>
        p.reason === "silentlyIncomplete"
          ? `Python 报告创建成功，但独立环境不完整——${p.path ?? ""} 不存在。`
          : "创建独立 Python 环境失败。",
      dependenciesFailed: () =>
        "安装 Python 依赖失败（pip install -r requirements.txt）。常见原因是网络不通或缺少编译工具链。",
      attributionFailed: () => "上游的署名与执行门禁校验未通过，安装包可能不完整或被改动过。",
      downloadFailed: () => "下载固定版本的发布包失败，请检查网络后重试。",
      checksumMismatch: (p) =>
        `发布包校验和不匹配：期望 ${p.expected ?? ""}，实际 ${p.actual ?? ""}。上游产物可能已变动，重试无法解决。`,
      archiveRejected: (p) => {
        if (p.reason === "size") return `发布包超过安装器的大小上限（${p.limitMb ?? ""} MB）。`;
        if (p.reason === "extractedSize") return `解压后的文件超过安装器的大小上限（${p.limitMb ?? ""} MB）。`;
        if (p.reason === "fileCount") return `发布包内文件数超过上限（${p.limit ?? ""}）。`;
        if (p.reason === "symlink") return "发布包内含符号链接，安装器拒绝解压。";
        if (p.reason === "unsafePath") return "发布包内含越界路径，安装器拒绝解压。";
        return "发布包未通过安装器的安全检查。";
      },
      packageIncomplete: (p) =>
        p.missing === "identity"
          ? `安装包的身份信息与固定清单不符（期望版本 ${p.expectedVersion ?? ""}）。`
          : `安装包缺少 ${p.missing ?? "必需文件"}。`,
      filesystemFailed: (p) => `文件操作失败（${p.operation ?? ""}）：${p.path ?? ""}`,
      notReady: (p) => `安装流程未报错，但结果仍不可用（状态：${p.state ?? "未知"}）。`,
    },
    pptMasterChecks: {
      python: "Python 解释器",
      skillSlot: "技能安装位置",
    },
    pptMasterEvidence: "原始输出",
    pptMasterFixOpenUrl: "前往下载",
    pptMasterFixRevealPath: "在文件管理器中打开",
    pptMasterFixRetry: "重试",
    argumentHintPrefix: (hint) => `参数：${hint}`,
    view: "查看",
    skillDetailsAria: "技能详情",
    pathLabel: "路径",
    argumentsMetaLabel: "参数",
    toolsMetaLabel: "工具",
    selectASkill: "选择一个技能",
    selectSkillHint: "点开左侧列表后，会在这里查看技能说明和完整 SKILL.md。",
    closeAria: "关闭",
    mcpDetailsAria: "MCP 详情",
    globalStdio: "全局配置 · STDIO",
    globalConfigPath: "全局配置",
    newMcpFallbackName: "新 MCP",
    editable: "可编辑",
    readonly: "只读",
    checkingTools: "检测中...",
    testTools: "检测工具",
    delete: "删除",
    runtimeStatusHint: (testToolsLabel) =>
      `配置文件存在不代表工具已经加载。点击"${testToolsLabel}"确认服务器实际返回的工具。`,
    toolsLoadedOk: "工具加载成功",
    toolsLoadedFailed: "工具加载失败",
    nameLabel: "名称",
    commandLabel: "命令",
    argsPerLineLabel: "参数，每行一个",
    envVarsLabel: "环境变量，KEY=value",
    timeoutSecondsLabel: "超时秒数",
    saving: "保存中...",
    addMcp: "添加 MCP",
    saveSettings: "保存设置",
    saved: "已保存",
    saveBeforeTest: "先保存再验证",
    unsavedTestHint: "当前修改尚未保存。先保存设置，再验证实际生效的 MCP 配置。",
    cancel: "取消",
    reloadNote: "保存后，下一条对话消息会重新发现并加载 MCP 工具。",
    sourceLabelHeading: "来源",
    connectionTypeLabel: "连接类型",
    viewOnlyNote: "该 MCP 来自外部用户配置，只能在其来源文件中修改。",
    managedOracleNote: "Oracle 由 SomniQ 受管接入，只暴露网页咨询、图片生成和独立审稿能力，不开放上游全部工具。",
    managedReady: "运行时可用",
    managedUnavailable: "运行时不可用",
    installOracle: "安装 Oracle",
    updateOracle: "更新 Oracle",
    installingOracle: "处理中...",
    oracleSettings: "账号与用途设置",
    sourceLabels: {
      project: "当前项目",
      user: "用户配置",
      local: "本地配置",
      global: "SomniQ 全局",
      managed: "SomniQ 受管",
    },
    skillSourceBundled: "内置",
    skillSourceLocal: "本地",
    catalog: {
      codexDescription: "把 OpenAI Codex 作为外部推理 / 审稿代理（codex · codex-reply）",
      claudeDescription: "接入 Claude Code 的完整工具集（Read / Edit / Grep / Agent …）",
      playwrightDescription: "通过 SomniQ 内置 Playwright MCP 实现浏览器自动化。",
    },
  },
  en: {
    title: "Plugins",
    subtitle: "Manage MCP, ChatGPT webpage accounts, and local skills in one place. Configuration is global to this account.",
    tabsAriaLabel: "Plugins and skills",
    pluginsTab: "MCP",
    skillsTab: "Skills",
    desktopOnlyPrefix: "Plugins and skills need desktop support. Run ",
    desktopOnlySuffix: ".",
    loadingMcp: "Loading MCP...",
    loadingSkillContent: "Loading SKILL.md…",
    connectedHeading: "MCP services",
    configuredHeading: "Configured MCP",
    configuredSubtitle: "Configured and runtime states are not connectivity claims; verify to confirm tools actually load.",
    testAll: "Verify all",
    verified: "Verified",
    failed: "Failed",
    ready: "Runtime ready",
    needsSetup: "Needs setup",
    notTested: "Not verified",
    available: "Available locally",
    unavailable: "Unavailable locally",
    bundledInstallPath: "Bundled path",
    noConnectedPlugins: "No MCP plugins connected yet",
    addCustomMcp: "Add custom MCP",
    recommended: "Recommended",
    added: "Added",
    add: "Add",
    skillsHeading: "Skills",
    skillsSubtitle: "Click a skill to view its description, path, and full SKILL.md.",
    noSkillsFound: "No skills found",
    managedSkillsHeading: "Managed skills",
    managedSkillsSubtitle: "Pinned versions, isolated runtimes, and explicit updates managed by SomniQ.",
    pptMasterDescription: "Generate, reconstruct, and edit native editable PPTX decks with per-slide SVG previews.",
    openPptPreview: "Slide preview",
    installPptMaster: "Install",
    updatePptMaster: "Update",
    repairPptMaster: "Repair runtime",
    removePptMaster: "Uninstall",
    installingPptMaster: "Installing dependencies…",
    removingPptMaster: "Uninstalling…",
    pptMasterReady: "Skill and private Python environment are ready",
    pptMasterNeedsRepair: "Python environment is incomplete",
    pptMasterUnmanaged: "A same-name local Skill exists; SomniQ will not overwrite it",
    pptMasterVersion: (version) => `Pinned version v${version}`,
    removePptMasterConfirm: "Uninstall the SomniQ-managed PPT Master Skill and its private Python environment?",
    pptMasterErrors: {
      unmanaged: (p) => `A ppt-master Skill from another source is active (${p.path ?? "unknown path"}). SomniQ will not overwrite or remove it — move it aside first.`,
      pythonMissing: (p) => `No Python interpreter found (looked for ${p.command ?? "python"} on PATH). Install Python and retry, or point SOMNIQ_PYTHON at one.`,
      venvFailed: (p) =>
        p.reason === "silentlyIncomplete"
          ? `Python reported success but the private environment is incomplete — ${p.path ?? ""} does not exist.`
          : "Could not create the private Python environment.",
      dependenciesFailed: () =>
        "Installing the Python dependencies failed (pip install -r requirements.txt). Usually a network problem or a missing build toolchain.",
      attributionFailed: () => "The upstream attribution and execution-gate check failed; the package may be incomplete or modified.",
      downloadFailed: () => "Could not download the pinned release. Check the network and retry.",
      checksumMismatch: (p) =>
        `Release checksum mismatch: expected ${p.expected ?? ""}, received ${p.actual ?? ""}. The upstream artifact changed; retrying will not help.`,
      archiveRejected: (p) => {
        if (p.reason === "size") return `The release archive exceeds the installer size limit (${p.limitMb ?? ""} MB).`;
        if (p.reason === "extractedSize") return `The extracted files exceed the installer size limit (${p.limitMb ?? ""} MB).`;
        if (p.reason === "fileCount") return `The archive holds more files than the installer allows (${p.limit ?? ""}).`;
        if (p.reason === "symlink") return "The archive contains a symbolic link; the installer refused to extract it.";
        if (p.reason === "unsafePath") return "The archive contains an out-of-tree path; the installer refused to extract it.";
        return "The archive failed the installer's safety checks.";
      },
      packageIncomplete: (p) =>
        p.missing === "identity"
          ? `The package identity does not match the pinned manifest (expected version ${p.expectedVersion ?? ""}).`
          : `The package is missing ${p.missing ?? "a required file"}.`,
      filesystemFailed: (p) => `A file operation failed (${p.operation ?? ""}): ${p.path ?? ""}`,
      notReady: (p) => `Every step reported success, but the result is still unusable (state: ${p.state ?? "unknown"}).`,
    },
    pptMasterChecks: {
      python: "Python interpreter",
      skillSlot: "Skill install location",
    },
    pptMasterEvidence: "Raw output",
    pptMasterFixOpenUrl: "Open download page",
    pptMasterFixRevealPath: "Show in file manager",
    pptMasterFixRetry: "Retry",
    argumentHintPrefix: (hint) => `Args: ${hint}`,
    view: "View",
    skillDetailsAria: "Skill details",
    pathLabel: "Path",
    argumentsMetaLabel: "Arguments",
    toolsMetaLabel: "Tools",
    selectASkill: "Select a skill",
    selectSkillHint: "Pick one from the list on the left to see its description and full SKILL.md here.",
    closeAria: "Close",
    mcpDetailsAria: "MCP details",
    globalStdio: "Global configuration · STDIO",
    globalConfigPath: "Global configuration",
    newMcpFallbackName: "New MCP",
    editable: "Editable",
    readonly: "Read-only",
    checkingTools: "Checking...",
    testTools: "Test tools",
    delete: "Delete",
    runtimeStatusHint: (testToolsLabel) =>
      `A config file existing doesn't mean the tools have loaded. Click "${testToolsLabel}" to confirm the tools the server actually returns.`,
    toolsLoadedOk: "Tools loaded successfully",
    toolsLoadedFailed: "Tools failed to load",
    nameLabel: "Name",
    commandLabel: "Command",
    argsPerLineLabel: "Arguments, one per line",
    envVarsLabel: "Environment variables, KEY=value",
    timeoutSecondsLabel: "Timeout (seconds)",
    saving: "Saving...",
    addMcp: "Add MCP",
    saveSettings: "Save settings",
    saved: "Saved",
    saveBeforeTest: "Save before testing",
    unsavedTestHint: "These changes are not saved. Save first, then verify the MCP configuration that will actually be used.",
    cancel: "Cancel",
    reloadNote: "After saving, the next chat message will rediscover and load MCP tools.",
    sourceLabelHeading: "Source",
    connectionTypeLabel: "Connection type",
    viewOnlyNote: "This MCP comes from an external user configuration and can only be changed in its source file.",
    managedOracleNote: "Oracle is managed by SomniQ and exposes only webpage consultation, image generation, and independent review—not every upstream tool.",
    managedReady: "Runtime ready",
    managedUnavailable: "Runtime unavailable",
    installOracle: "Install Oracle",
    updateOracle: "Update Oracle",
    installingOracle: "Working...",
    oracleSettings: "Accounts and capabilities",
    sourceLabels: {
      project: "Current project",
      user: "User config",
      local: "Local config",
      global: "SomniQ global",
      managed: "SomniQ-managed",
    },
    skillSourceBundled: "Bundled",
    skillSourceLocal: "Local",
    catalog: {
      codexDescription: "Use OpenAI Codex as an external reasoning / review agent (codex · codex-reply)",
      claudeDescription: "Connect Claude Code's full toolset (Read / Edit / Grep / Agent …)",
      playwrightDescription: "Browser automation via SomniQ bundled Playwright MCP.",
    },
  },
};

type ExtensionsCopyTable = (typeof EXTENSIONS_COPY)[Language];

/**
 * Recover the structured error from a Tauri rejection.
 *
 * `invoke` rejects with whatever the command's error type serialized to, so a
 * `PptMasterError` arrives as a plain object. Callers used to run the rejection
 * through `String(error)`, which turns that object into `"[object Object]"` —
 * strictly worse than the English string it replaced. This narrows instead.
 */
export function asPptMasterError(error: unknown): PptMasterError | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as Partial<PptMasterError>;
  if (typeof candidate.code !== "string") return null;
  return {
    code: candidate.code,
    params: candidate.params ?? {},
    detail: typeof candidate.detail === "string" ? candidate.detail : "",
    fix: candidate.fix ?? null,
  };
}

/**
 * Localized sentence for an installer failure.
 *
 * An unknown code cannot happen while the Rust test
 * `installer_error_codes_are_exhaustive` and this table agree, but a stale
 * frontend against a newer backend still degrades to the raw evidence rather
 * than to an empty toast.
 */
export function pptMasterErrorText(
  error: PptMasterError,
  copy: ExtensionsCopyTable,
): string {
  const render = copy.pptMasterErrors[error.code];
  if (!render) return error.detail || error.code;
  return render(error.params);
}

/** Label for the one action a failure offers, or `null` when it offers none. */
export function pptMasterFixLabel(
  error: Pick<PptMasterError, "fix">,
  copy: ExtensionsCopyTable,
): string | null {
  if (!error.fix) return null;
  if (error.fix.kind === "openUrl") return copy.pptMasterFixOpenUrl;
  if (error.fix.kind === "revealPath") return copy.pptMasterFixRevealPath;
  return copy.pptMasterFixRetry;
}

/** Localized label for a preflight check row. */
export function pptMasterCheckLabel(
  check: PptMasterCheck,
  copy: ExtensionsCopyTable,
): string {
  return copy.pptMasterChecks[check.id] ?? check.id;
}
