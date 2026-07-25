import type { Language } from "../store";

export const EXTENSIONS_COPY: Record<Language, {
  tabsAriaLabel: string;
  pluginsTab: string;
  skillsTab: string;
  desktopOnlyPrefix: string;
  desktopOnlySuffix: string;
  loadingMcp: string;
  loadingSkillContent: string;
  connectedHeading: string;
  noConnectedPlugins: string;
  addCustomMcp: string;
  recommended: string;
  added: string;
  add: string;
  skillsHeading: string;
  skillsSubtitle: string;
  noSkillsFound: string;
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
  currentProjectStdio: string;
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
  cancel: string;
  reloadNote: string;
  sourceLabelHeading: string;
  connectionTypeLabel: string;
  viewOnlyNote: string;
  sourceLabels: {
    project: string;
    user: string;
    local: string;
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
    tabsAriaLabel: "插件与技能",
    pluginsTab: "插件",
    skillsTab: "技能",
    desktopOnlyPrefix: "插件与技能需要桌面端支持。运行 ",
    desktopOnlySuffix: "。",
    loadingMcp: "正在读取 MCP...",
    loadingSkillContent: "正在读取 SKILL.md…",
    connectedHeading: "已连接",
    noConnectedPlugins: "还没有连接任何 MCP 插件",
    addCustomMcp: "添加自定义 MCP",
    recommended: "推荐",
    added: "已添加",
    add: "添加",
    skillsHeading: "技能",
    skillsSubtitle: "点击一个技能查看说明、路径和完整 SKILL.md。",
    noSkillsFound: "未发现可用技能",
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
    currentProjectStdio: "当前项目 · STDIO",
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
    cancel: "取消",
    reloadNote: "保存后，下一条对话消息会重新发现并加载 MCP 工具。",
    sourceLabelHeading: "来源",
    connectionTypeLabel: "连接类型",
    viewOnlyNote: "该 MCP 不属于当前项目的 STDIO 配置，因此只能查看。",
    sourceLabels: {
      project: "当前项目",
      user: "用户配置",
      local: "本地配置",
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
    tabsAriaLabel: "Plugins and skills",
    pluginsTab: "Plugins",
    skillsTab: "Skills",
    desktopOnlyPrefix: "Plugins and skills need desktop support. Run ",
    desktopOnlySuffix: ".",
    loadingMcp: "Loading MCP...",
    loadingSkillContent: "Loading SKILL.md…",
    connectedHeading: "Connected",
    noConnectedPlugins: "No MCP plugins connected yet",
    addCustomMcp: "Add custom MCP",
    recommended: "Recommended",
    added: "Added",
    add: "Add",
    skillsHeading: "Skills",
    skillsSubtitle: "Click a skill to view its description, path, and full SKILL.md.",
    noSkillsFound: "No skills found",
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
    currentProjectStdio: "Current project · STDIO",
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
    cancel: "Cancel",
    reloadNote: "After saving, the next chat message will rediscover and load MCP tools.",
    sourceLabelHeading: "Source",
    connectionTypeLabel: "Connection type",
    viewOnlyNote: "This MCP isn't part of the current project's STDIO config, so it's view-only.",
    sourceLabels: {
      project: "Current project",
      user: "User config",
      local: "Local config",
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
