import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import {
  pluginsCheckMcp, pluginsInstall, pluginsList, pluginsPreview, pluginsRemove, pluginsSetEnabled, pluginsUpgrade,
  type InstalledPlugin, type ListChange, type PluginImportPreview, type PluginLifecycle, type PluginMcpStatus,
  type PluginPreview, type PluginState, type PluginUpgradePlan,
} from "../api/plugins";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import type { Language } from "../store";
import { uiText } from "./useChatPluginPanels";
import "./PluginPackages.css";

const COPY = {
  cn: {
    title: "插件包", scope: "本项目", description: "导入本地插件包，为这个项目添加 Skills、MCP 和 Chat 侧栏面板。",
    add: "导入本地插件包", importTitle: "导入本地插件包", importHint: "先预览来源、版本和能力，确认后再安装。",
    path: "插件包目录", placeholder: "选择包含 package.json 的本地目录", browse: "选择目录",
    preview: "预览", previewKicker: "安装预览", install: "安装并保持停用", cancel: "取消", close: "关闭导入", refresh: "刷新插件包",
    loading: "正在读取插件包…", working: "处理中…",
    emptyTitle: "还没有插件包", empty: "插件包可以为研究项目添加 Skills、MCP 工具和 Chat 侧栏面板。导入前会先展示来源、版本和能力。",
    emptyAction: "从本地目录导入",
    enable: "启用", disable: "停用", remove: "移除", details: "详情", hideDetails: "收起详情",
    source: "本地来源", snapshot: "文件快照", skills: "Skills", mcp: "MCP", ui: "Chat 面板", none: "无",
    noCapabilities: "未声明可用能力",
    compatible: "可接入", blocked: "需要适配", enabled: "已启用", disabled: "已停用", cannotEnable: "无法启用",
    approvalPending: "待本机批准", running: "运行中", failed: "MCP 连接失败", needsRestart: "需重新开始",
    enabledHint: "下一次运行开始生效。",
    runningHint: (runs: number) => `${runs} 个正在运行的回合或任务在使用这个版本。`,
    restartHint: (runs: number) => `${runs} 个正在运行的回合或任务仍使用开始时的插件集；改动在它们下一次开始时生效。`,
    restartDisabledHint: (runs: number) => `已停用，但 ${runs} 个正在运行的回合或任务会继续使用它，直到结束。`,
    failedHint: "上次连接 MCP 服务失败，Chat 拿不到它的工具。处理后点“检查连接”重试。",
    mcpHealth: "MCP 连接", mcpConnected: (tools: number) => `已连接 · ${tools} 个工具`, mcpFailed: "连接失败",
    mcpUnchecked: "尚未连接（下一次对话开始时连接）", checkMcp: "检查连接", checking: "正在连接…",
    nextRun: "Chat 面板启用后立即出现在 Chat 顶部的面板按钮和侧栏 + 菜单中；Skills 和 MCP 从下一次运行开始生效。正在运行的回合和工作任务继续使用它们开始时的插件集。",
    previewNote: "安装后默认停用；启用时只接入当前项目，并记录在本机。本地 Skills 优先，SomniQ 自带的 Skill 不会被替换。",
    blockedTitle: "需要 DeepSeek 宿主能力",
    blockedNote: "此包依赖 SomniQ 尚未提供的宿主能力或配置，解决以下问题后才能启用。",
    blockedLocalTitle: "暂时不能启用", blockedLocalNote: "先处理下面的问题，再启用这个包。",
    approvalRequired: "项目文件要求运行这个包，但本机还没有批准这个版本，所以它不会运行。确认来源可信后打开开关即可批准。",
    confirmRemove: "移除后，此项目不再加载它的 Skills、MCP 和面板。会话中已保存的面板内容会保留。",
    confirm: "确认移除",
    enableMcpTitle: "启用后将在本机运行以下命令",
    enableMcpNote: "这些 MCP 服务会在每次对话开始时以你的身份启动，不在沙箱内运行。只启用你信任来源的插件包。",
    envKeys: "环境变量", confirmEnable: "确认启用",
    upgradeKicker: "升级预览", installedVersion: "已安装",
    change: { upgrade: "升级", downgrade: "降级", "same-version": "同版本号、内容不同", identical: "与已安装版本相同" },
    diffApproved: "与本机已批准的版本相比", diffInstalled: "与已安装的版本相比",
    commands: "运行的命令", noChanges: "Skills、面板、命令和环境变量都没有变化。",
    upgradeApprove: "升级并重新批准", upgradeKeepDisabled: "升级并保持停用", upgradeAndDisable: "升级并停用",
    upgradeApproveNote: "新版本会以你的身份运行上面的命令。新版本就位前，旧版本及其批准一直有效；任一步失败都会回滚。正在运行的回合继续使用旧版本。",
    upgradeDisabledNote: "升级后保持停用，启用时再批准。正在运行的回合不受影响。",
    upgradeBlockedNote: "新版本暂时不能启用，升级后这个包会停用。正在运行的回合继续使用旧版本。",
    identicalNote: "已经安装了完全相同的版本，无需升级。",
    noProject: "选择项目后管理插件包。", retry: "重新加载", loadFailed: "插件包读取失败",
  },
  en: {
    title: "Plugin packages", scope: "This project", description: "Import local packages to add Skills, MCP and Chat side panels to this project.",
    add: "Import local package", importTitle: "Import a local package", importHint: "Preview the source, version and capabilities before installing.",
    path: "Package directory", placeholder: "Local directory containing package.json", browse: "Choose directory",
    preview: "Preview", previewKicker: "Install preview", install: "Install disabled", cancel: "Cancel", close: "Close import", refresh: "Refresh packages",
    loading: "Loading packages…", working: "Working…",
    emptyTitle: "No plugin packages yet", empty: "Packages add Skills, MCP tools and Chat side panels to a research project. You can review the source, version and capabilities before importing.",
    emptyAction: "Import from a folder",
    enable: "Enable", disable: "Disable", remove: "Remove", details: "Details", hideDetails: "Hide details",
    source: "Local source", snapshot: "File snapshot", skills: "Skills", mcp: "MCP", ui: "Chat panels", none: "None",
    noCapabilities: "No capabilities declared",
    compatible: "Compatible", blocked: "Needs adaptation", enabled: "Enabled", disabled: "Disabled", cannotEnable: "Can't enable",
    approvalPending: "Needs approval", running: "Running", failed: "MCP failed", needsRestart: "Restart needed",
    enabledHint: "Applies from the next run.",
    runningHint: (runs: number) => `In use by ${runs} running ${runs === 1 ? "turn or task" : "turns or tasks"}.`,
    restartHint: (runs: number) => `${runs} running ${runs === 1 ? "turn or task still uses" : "turns or tasks still use"} the set it started with; the change applies when ${runs === 1 ? "it next starts" : "they next start"}.`,
    restartDisabledHint: (runs: number) => `Disabled, but ${runs} running ${runs === 1 ? "turn or task keeps" : "turns or tasks keep"} using it until ${runs === 1 ? "it ends" : "they end"}.`,
    failedHint: "The last connection to its MCP servers failed, so Chat doesn't get their tools. Fix it, then check the connection again.",
    mcpHealth: "MCP connection", mcpConnected: (tools: number) => `Connected · ${tools} ${tools === 1 ? "tool" : "tools"}`, mcpFailed: "Failed",
    mcpUnchecked: "Not connected yet (connects when the next conversation starts)", checkMcp: "Check connection", checking: "Connecting…",
    nextRun: "Enabled Chat panels appear right away in the Chat header and the sidebar + menu. Skills and MCP apply from the next run; turns and work tasks already running keep the set they started with.",
    previewNote: "Packages install disabled. Enabling approves them on this computer for this project only. Local Skills take priority, and SomniQ's built-in Skills are never replaced.",
    blockedTitle: "Needs DeepSeek host capabilities",
    blockedNote: "This package relies on host capabilities or configuration SomniQ doesn't provide yet. Resolve these before enabling it.",
    blockedLocalTitle: "Can't enable yet", blockedLocalNote: "Resolve the issues below before enabling this package.",
    approvalRequired: "This project's files ask to run this package, but this computer hasn't approved this version, so it won't run. Turn it on once you trust the source to approve it.",
    confirmRemove: "This project will stop loading its Skills, MCP and panels. Panel content saved in conversations is kept.",
    confirm: "Remove package",
    enableMcpTitle: "Enabling runs these commands on this computer",
    enableMcpNote: "These MCP servers start as you at the beginning of every conversation and do not run in the sandbox. Only enable packages from sources you trust.",
    envKeys: "Environment", confirmEnable: "Enable package",
    upgradeKicker: "Upgrade preview", installedVersion: "Installed",
    change: { upgrade: "Upgrade", downgrade: "Downgrade", "same-version": "Same version, different files", identical: "Same as installed" },
    diffApproved: "Compared with the version approved on this computer", diffInstalled: "Compared with the installed version",
    commands: "Commands", noChanges: "No change to Skills, panels, commands or environment keys.",
    upgradeApprove: "Upgrade and re-approve", upgradeKeepDisabled: "Upgrade, keep disabled", upgradeAndDisable: "Upgrade and disable",
    upgradeApproveNote: "The new version runs the commands above as you. The installed version and its approval stay in force until the new one is in place, and any failure rolls back. Runs in progress keep the old version.",
    upgradeDisabledNote: "The package stays disabled; you approve it when you enable it. Runs in progress are not affected.",
    upgradeBlockedNote: "The new version can't be enabled yet, so the package is disabled by the upgrade. Runs in progress keep the old version.",
    identicalNote: "This exact version is already installed; there is nothing to upgrade.",
    noProject: "Select a project to manage packages.", retry: "Reload", loadFailed: "Couldn't load packages",
  },
};
type Copy = typeof COPY["cn"];

function splitName(name: string) {
  const slash = name.startsWith("@") ? name.indexOf("/") : -1;
  return slash > 0 ? { scope: name.slice(0, slash + 1), base: name.slice(slash + 1) } : { scope: "", base: name };
}

const monogram = (name: string) => (splitName(name).base.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

/** The lifecycle the backend reports, or one derived from configuration alone. */
function lifecycleOf(item: InstalledPlugin): PluginLifecycle {
  return item.lifecycle ?? {
    state: item.status === "blocked" ? "blocked" : item.enabled ? "enabled" : "installed",
    activeRuns: 0, staleRuns: 0, mcpServers: [],
  };
}

type StateLabel = "disabled" | "approvalPending" | "cannotEnable" | "enabled" | "running" | "failed" | "needsRestart";
const STATE_LABEL: Record<PluginState, StateLabel> = {
  installed: "disabled", "approval-required": "approvalPending", blocked: "cannotEnable",
  enabled: "enabled", running: "running", failed: "failed", "needs-restart": "needsRestart",
};

function stateHint(item: InstalledPlugin, lifecycle: PluginLifecycle, copy: Copy): string | null {
  switch (lifecycle.state) {
    case "enabled": return copy.enabledHint;
    case "running": return copy.runningHint(lifecycle.activeRuns);
    case "failed": return copy.failedHint;
    case "needs-restart": return item.enabled ? copy.restartHint(lifecycle.staleRuns) : copy.restartDisabledHint(lifecycle.staleRuns);
    default: return null;
  }
}

function Chip({ icon, label }: { icon: SvgIconName; label: string }) {
  return <span className="plugin-chip"><SvgIcon name={icon} size={12} />{label}</span>;
}

function CapabilityChips({ item, copy }: { item: PluginPreview; copy: Copy }) {
  const { skills, mcpServers, uiPanels } = item.capabilities;
  const chips = [
    uiPanels.length > 0 && <Chip key="ui" icon="panelRight" label={`${uiPanels.length} ${copy.ui}`} />,
    skills.length > 0 && <Chip key="skills" icon="sparkle" label={`${skills.length} ${copy.skills}`} />,
    mcpServers.length > 0 && <Chip key="mcp" icon="lightning" label={`${mcpServers.length} ${copy.mcp}`} />,
  ].filter(Boolean);
  return <div className="plugin-chips">{chips.length > 0 ? chips : <span className="plugin-chip is-empty">{copy.noCapabilities}</span>}</div>;
}

function McpServers({ servers, copy }: { servers: PluginPreview["capabilities"]["mcpServers"]; copy: Copy }) {
  return <ul className="plugin-servers">{servers.map((server) => {
    const env = Object.keys(server.env ?? {});
    return <li key={server.name}>
      <strong>{server.name}</strong><code>{[server.command, ...server.args].join(" ")}</code>
      {env.length > 0 && <span className="plugin-env">{copy.envKeys}: {env.map((key) => <code key={key}>{key}</code>)}</span>}
    </li>;
  })}</ul>;
}

function PackageDetails({ item, copy, language, id }: { item: PluginPreview; copy: Copy; language: Language; id?: string }) {
  const { skills, mcpServers, uiPanels } = item.capabilities;
  return <dl className="plugin-details" id={id}>
    <div><dt>{copy.skills}</dt><dd>{skills.length ? <span className="plugin-tags">{skills.map((skill) => <code key={skill}>{skill}</code>)}</span> : copy.none}</dd></div>
    <div><dt>{copy.mcp}</dt><dd>{mcpServers.length ? <McpServers servers={mcpServers} copy={copy} /> : copy.none}</dd></div>
    <div><dt>{copy.ui}</dt><dd>{uiPanels.length ? uiPanels.map((panel) => uiText(panel.title, language)).join("、") : copy.none}</dd></div>
    <div><dt>{copy.source}</dt><dd><code className="plugin-path">{item.source}</code></dd></div>
    <div><dt>{copy.snapshot}</dt><dd><code title={item.digest}>{item.digest.slice(0, 16)}</code></dd></div>
  </dl>;
}

/** Blockers SomniQ itself raises; anything else is a DSH host capability it lacks. */
const LOCAL_BLOCKERS = new Set(["integrity", "approvals", "skill-builtin", "skill-alias", "duplicate-capability", "empty"]);

function Diagnostics({ item, copy }: { item: PluginPreview; copy: Copy }) {
  if (item.canEnable && item.diagnostics.length === 0) return null;
  const errors = item.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const local = errors.length > 0 && errors.every((diagnostic) => LOCAL_BLOCKERS.has(diagnostic.code));
  const warn = !item.canEnable || item.diagnostics.some((diagnostic) => diagnostic.severity !== "info");
  return <div className={`plugin-callout ${warn ? "is-warning" : "is-info"}`}>
    <SvgIcon name={warn ? "warning" : "info"} size={15} />
    <div>
      {!item.canEnable && <><strong>{local ? copy.blockedLocalTitle : copy.blockedTitle}</strong><p>{local ? copy.blockedLocalNote : copy.blockedNote}</p></>}
      {item.diagnostics.length > 0 && <ul>{item.diagnostics.map((diagnostic, index) =>
        <li key={`${diagnostic.code}-${index}`}><code>{diagnostic.code}</code>
          <span>{diagnostic.code === "approval-required" ? copy.approvalRequired : diagnostic.message}</span></li>)}</ul>}
    </div>
  </div>;
}

function PackageHeading({ item, copy, badge, children }: {
  item: PluginPreview; copy: Copy; badge?: "compatible" | "blocked"; children?: ReactNode;
}) {
  const { scope, base } = splitName(item.name);
  return <div className="plugin-card-copy">
    <div className="plugin-card-title">
      <strong title={item.name}>{scope && <span className="plugin-scope">{scope}</span>}{base}</strong>
      <span className="plugin-version">v{item.version}</span>
      {badge && <span className={`plugin-badge ${badge === "blocked" ? "is-warning" : "is-ok"}`}>{copy[badge]}</span>}
    </div>
    {item.description && <p className="plugin-card-desc">{item.description}</p>}
    <div className="plugin-card-meta"><CapabilityChips item={item} copy={copy} />{children}</div>
  </div>;
}

function healthText(server: PluginMcpStatus, copy: Copy) {
  if (server.health === "connected") return copy.mcpConnected(server.toolCount);
  if (server.health === "failed") return copy.mcpFailed;
  return copy.mcpUnchecked;
}

/** What the last real discovery saw for each MCP server of an approved package. */
function McpHealth({ name, servers, copy, canCheck, checking, onCheck }: {
  name: string; servers: PluginMcpStatus[]; copy: Copy; canCheck: boolean; checking: boolean; onCheck: () => void;
}) {
  return <div className="plugin-health" role="group" aria-label={`${copy.mcpHealth} ${name}`}>
    <ul>{servers.map((server) => <li key={server.name} className={`is-${server.health}`}>
      <span className="plugin-health-dot" aria-hidden="true" />
      <strong title={server.runtimeName}>{server.name}</strong>
      <span>{healthText(server, copy)}</span>
      {server.message && <code title={server.message}>{server.message}</code>}
    </li>)}</ul>
    {canCheck && <button type="button" className="ext-secondary-btn plugin-check-btn" disabled={checking} onClick={onCheck}>
      <SvgIcon name={checking ? "spinner" : "refresh"} size={12} />{checking ? copy.checking : copy.checkMcp}
    </button>}
  </div>;
}

function InstalledCard({ item, copy, language, busy, checking, onToggle, onRemove, onCheck }: {
  item: InstalledPlugin; copy: Copy; language: Language; busy: boolean; checking: boolean;
  onToggle: () => void; onRemove: () => void; onCheck: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirming, setConfirming] = useState<"remove" | "enable" | null>(null);
  const detailsId = useId();
  const lifecycle = lifecycleOf(item);
  const blocked = item.status === "blocked";
  const canToggle = item.enabled || item.canEnable;
  const stateLabel = copy[STATE_LABEL[lifecycle.state]];
  const hint = stateHint(item, lifecycle, copy);
  const servers = item.capabilities.mcpServers;
  // Enabling a package that declares MCP servers starts local processes outside
  // the sandbox, so the exact commands are shown before the switch flips.
  const requestToggle = () => {
    if (!item.enabled && servers.length > 0) setConfirming((value) => value === "enable" ? null : "enable");
    else onToggle();
  };
  return <article className={`plugin-card is-${item.enabled ? "enabled" : blocked ? "blocked" : "disabled"} is-state-${lifecycle.state}`} aria-label={item.name}>
    <div className="plugin-card-main">
      <span className="plugin-card-mark" aria-hidden="true">{blocked && !item.enabled ? <SvgIcon name="warning" size={16} /> : monogram(item.name)}</span>
      <PackageHeading item={item} copy={copy} badge={blocked ? "blocked" : undefined}>
        <button type="button" className="plugin-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen((value) => !value)}>
          {detailsOpen ? copy.hideDetails : copy.details}<SvgIcon name={detailsOpen ? "chevronUp" : "chevronDown"} size={12} />
        </button>
      </PackageHeading>
      <div className="plugin-card-controls">
        <span className={`plugin-state is-${lifecycle.state}`}>{stateLabel}</span>
        <button type="button" role="switch" className="plugin-switch" aria-checked={item.enabled}
          aria-label={`${item.enabled ? copy.disable : copy.enable} ${item.name}`}
          disabled={busy || !canToggle} onClick={requestToggle}><span /></button>
        <button type="button" className="plugin-icon-btn is-danger" aria-label={`${copy.remove} ${item.name}`} title={copy.remove}
          disabled={busy} aria-expanded={confirming === "remove"} onClick={() => setConfirming((value) => value === "remove" ? null : "remove")}><SvgIcon name="trash" size={14} /></button>
      </div>
    </div>
    {hint && <p className={`plugin-state-hint is-${lifecycle.state}`}>{hint}</p>}
    {item.enabled && lifecycle.mcpServers.length > 0 && <McpHealth name={item.name} servers={lifecycle.mcpServers} copy={copy}
      canCheck={item.canEnable} checking={checking} onCheck={onCheck} />}
    {confirming === "enable" && <div className="plugin-confirm is-caution" role="group" aria-label={`${copy.enable} ${item.name}`}>
      <div className="plugin-confirm-body">
        <strong><SvgIcon name="warning" size={14} />{copy.enableMcpTitle}</strong>
        <McpServers servers={servers} copy={copy} />
        <p>{copy.enableMcpNote}</p>
      </div>
      <div className="plugin-confirm-actions">
        <button type="button" className="ext-secondary-btn" onClick={() => setConfirming(null)}>{copy.cancel}</button>
        <button type="button" className="ext-primary-btn" disabled={busy} onClick={() => { setConfirming(null); onToggle(); }}>{copy.confirmEnable}</button>
      </div>
    </div>}
    {confirming === "remove" && <div className="plugin-confirm" role="group" aria-label={`${copy.remove} ${item.name}`}>
      <p>{copy.confirmRemove}</p>
      <div className="plugin-confirm-actions">
        <button type="button" className="ext-secondary-btn" onClick={() => setConfirming(null)}>{copy.cancel}</button>
        <button type="button" className="plugin-danger-btn" disabled={busy} onClick={onRemove}>{copy.confirm}</button>
      </div>
    </div>}
    <Diagnostics item={item} copy={copy} />
    {detailsOpen && <PackageDetails item={item} copy={copy} language={language} id={detailsId} />}
  </article>;
}

function Changes({ change, extra }: { change: ListChange; extra?: string[] }) {
  return <span className="plugin-diff-items">
    {change.added.map((value) => <code key={`+${value}`} className="is-added">+ {value}</code>)}
    {change.removed.map((value) => <code key={`-${value}`} className="is-removed">− {value}</code>)}
    {extra?.map((value) => <code key={`~${value}`} className="is-changed">~ {value}</code>)}
  </span>;
}

/** What the new version adds or drops against the installed (approved) one. */
function UpgradeDiff({ plan, copy }: { plan: PluginUpgradePlan; copy: Copy }) {
  const { diff } = plan;
  const title = plan.currentEnabled ? copy.diffApproved : copy.diffInstalled;
  const envChanged = [...new Set(diff.mcpServers.flatMap((server) => server.envChanged))];
  const rows: [string, ListChange, string[]?][] = [
    [copy.skills, diff.skills], [copy.ui, diff.uiPanels], [copy.commands, diff.commands], [copy.envKeys, diff.envKeys, envChanged],
  ];
  const shown = rows.filter(([, change, extra]) => change.added.length + change.removed.length + (extra?.length ?? 0) > 0);
  return <div className="plugin-diff" role="group" aria-label={title}>
    <strong>{title}</strong>
    {shown.length === 0 && !diff.changed ? <p>{copy.noChanges}</p> : <dl className="plugin-details">
      {shown.map(([label, change, extra]) => <div key={label}><dt>{label}</dt><dd><Changes change={change} extra={extra} /></dd></div>)}
    </dl>}
  </div>;
}

function UpgradePreview({ preview, plan, copy, language, busy, onCancel, onUpgrade }: {
  preview: PluginImportPreview; plan: PluginUpgradePlan; copy: Copy; language: Language; busy: boolean;
  onCancel: () => void; onUpgrade: (approve: boolean) => void;
}) {
  const identical = plan.change === "identical";
  const approve = plan.currentEnabled && preview.canEnable;
  const action = approve ? copy.upgradeApprove : plan.currentEnabled ? copy.upgradeAndDisable : copy.upgradeKeepDisabled;
  const note = identical ? copy.identicalNote : approve ? copy.upgradeApproveNote : plan.currentEnabled ? copy.upgradeBlockedNote : copy.upgradeDisabledNote;
  return <div className="plugin-import-preview">
    <span className="plugin-import-kicker">{copy.upgradeKicker}</span>
    <article className={`plugin-card is-preview${preview.canEnable ? "" : " is-blocked"}`} aria-label={preview.name}>
      <div className="plugin-card-main">
        <span className="plugin-card-mark" aria-hidden="true">{monogram(preview.name)}</span>
        <PackageHeading item={preview} copy={copy} badge={preview.canEnable ? "compatible" : "blocked"}>
          <span className="plugin-upgrade-versions">{copy.installedVersion} v{plan.currentVersion} → v{preview.version} · {copy.change[plan.change]}</span>
        </PackageHeading>
      </div>
      <Diagnostics item={preview} copy={copy} />
      {!identical && <UpgradeDiff plan={plan} copy={copy} />}
      <PackageDetails item={preview} copy={copy} language={language} />
    </article>
    <div className="plugin-import-actions">
      <p><SvgIcon name="shieldCheck" size={13} />{note}</p>
      <div>
        <button type="button" className="ext-secondary-btn" disabled={busy} onClick={onCancel}>{copy.cancel}</button>
        {!identical && <button type="button" className="ext-primary-btn" disabled={busy} onClick={() => onUpgrade(approve)}>{busy ? copy.working : action}</button>}
      </div>
    </div>
  </div>;
}

export default function PluginPackages({ projectPath, language, onChanged }: {
  projectPath: string | undefined;
  language: Language;
  onChanged: () => void;
}) {
  const copy = COPY[language];
  const [packages, setPackages] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<PluginImportPreview | null>(null);
  const epoch = useRef(0);
  const sourceInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const request = ++epoch.current;
    setPackages([]); setPreview(null); setSource(""); setError(""); setBusy(false); setChecking(null); setImportOpen(false);
    if (!projectPath) { setLoading(false); return; }
    setLoading(true);
    pluginsList(projectPath).then((items) => {
      if (epoch.current === request) setPackages(items);
    }).catch((failure: unknown) => {
      if (epoch.current === request) setError(String(failure));
    }).finally(() => { if (epoch.current === request) setLoading(false); });
    return () => { ++epoch.current; };
  }, [projectPath]);

  useEffect(() => { if (importOpen) sourceInput.current?.focus(); }, [importOpen]);

  async function act(action: () => Promise<void>) {
    const request = epoch.current;
    setBusy(true); setError("");
    try { await action(); }
    catch (failure) { if (epoch.current === request) setError(String(failure)); }
    finally { if (epoch.current === request) setBusy(false); }
  }

  function bound(action: () => Promise<void>) { void act(action); }

  const replace = (result: InstalledPlugin) =>
    setPackages((items) => items.map((entry) => entry.name === result.name ? result : entry));

  function openImport() { setImportOpen(true); setError(""); }
  function closeImport() { setImportOpen(false); setPreview(null); }

  function inspect() {
    if (!projectPath) return;
    const request = epoch.current;
    setPreview(null);
    bound(async () => {
      const result = await pluginsPreview(projectPath, source.trim());
      if (epoch.current === request) setPreview(result);
    });
  }

  function finishImport() { setPreview(null); setSource(""); setImportOpen(false); onChanged(); }

  function install() {
    if (!projectPath || !preview) return;
    const request = epoch.current;
    bound(async () => {
      const result = await pluginsInstall(projectPath, preview.source, preview.digest);
      if (epoch.current !== request) return;
      setPackages((items) => [...items, result].sort((a, b) => a.name.localeCompare(b.name)));
      finishImport();
    });
  }

  function upgrade(approve: boolean) {
    const plan = preview?.upgrade;
    if (!projectPath || !preview || !plan) return;
    const request = epoch.current;
    bound(async () => {
      const result = await pluginsUpgrade(projectPath, preview.source, preview.digest, plan.currentDigest, approve);
      if (epoch.current !== request) return;
      replace(result);
      finishImport();
    });
  }

  function toggle(item: InstalledPlugin) {
    if (!projectPath) return;
    const request = epoch.current;
    bound(async () => {
      const result = await pluginsSetEnabled(projectPath, item.name, !item.enabled);
      if (epoch.current !== request) return;
      replace(result); onChanged();
    });
  }

  function remove(item: InstalledPlugin) {
    if (!projectPath) return;
    const request = epoch.current;
    bound(async () => {
      await pluginsRemove(projectPath, item.name);
      if (epoch.current !== request) return;
      setPackages((items) => items.filter((entry) => entry.name !== item.name)); onChanged();
    });
  }

  /** A connection check can take a while; it holds only its own card. */
  function checkMcp(item: InstalledPlugin) {
    if (!projectPath) return;
    const request = epoch.current;
    setChecking(item.name); setError("");
    pluginsCheckMcp(projectPath, item.name).then((result) => {
      if (epoch.current === request) replace(result);
    }).catch((failure: unknown) => {
      if (epoch.current === request) setError(String(failure));
    }).finally(() => { if (epoch.current === request) setChecking(null); });
  }

  function refresh() {
    if (!projectPath) return;
    const request = epoch.current;
    bound(async () => {
      const items = await pluginsList(projectPath);
      if (epoch.current === request) setPackages(items);
    });
  }

  const enabledCount = packages.filter((item) => item.enabled).length;

  return <section className="ext-section plugin-packages" aria-label={copy.title} aria-busy={busy || loading}>
    <div className="ext-section-head">
      <div>
        <span className="ext-section-kicker">{copy.scope}</span>
        <h2>{copy.title}{packages.length > 0 && <span className="plugin-count" title={`${enabledCount} / ${packages.length} ${copy.enabled}`}>{enabledCount}/{packages.length}</span>}</h2>
        <p className="ext-section-sub">{copy.description}</p>
      </div>
      <div className="plugin-head-actions">
        <button type="button" className="ext-secondary-btn plugin-icon-only" disabled={busy || loading || !projectPath} onClick={refresh} aria-label={copy.refresh} title={copy.refresh}><SvgIcon name={busy ? "spinner" : "refresh"} size={14} /></button>
        <button type="button" className="ext-secondary-btn" disabled={busy || loading || !projectPath || importOpen} onClick={openImport}><SvgIcon name="plus" size={14} />{copy.add}</button>
      </div>
    </div>
    {error && <div className="plugin-callout is-error" role="alert">
      <SvgIcon name="error" size={15} />
      <div><strong>{copy.loadFailed}</strong><p>{error}</p></div>
      <button type="button" className="ext-secondary-btn" disabled={busy} onClick={refresh}>{copy.retry}</button>
    </div>}
    {!projectPath ? <div className="plugin-empty"><span className="plugin-empty-mark" aria-hidden="true"><SvgIcon name="folder" size={20} /></span><p>{copy.noProject}</p></div> : <>
      {importOpen && <div className="plugin-import" role="group" aria-label={copy.importTitle}>
        <div className="plugin-import-head">
          <span className="plugin-import-mark" aria-hidden="true"><SvgIcon name="folder" size={16} /></span>
          <div><strong>{copy.importTitle}</strong><p>{copy.importHint}</p></div>
          <button type="button" className="plugin-icon-btn" aria-label={copy.close} title={copy.close} disabled={busy} onClick={closeImport}><SvgIcon name="close" size={14} /></button>
        </div>
        <label htmlFor="plugin-package-source">{copy.path}</label>
        <form className="plugin-import-row" onSubmit={(event) => { event.preventDefault(); if (!busy && source.trim()) inspect(); }}>
          <input id="plugin-package-source" ref={sourceInput} value={source} disabled={busy} placeholder={copy.placeholder} spellCheck={false}
            onChange={(event) => { setSource(event.target.value); setPreview(null); }} />
          {"__TAURI_INTERNALS__" in window && <button type="button" className="ext-secondary-btn" disabled={busy} onClick={() => {
            const request = epoch.current;
            bound(async () => {
              const directory = await open({ directory: true, multiple: false });
              if (typeof directory === "string" && epoch.current === request) { setSource(directory); setPreview(null); }
            });
          }}><SvgIcon name="folder" size={14} />{copy.browse}</button>}
          <button type="submit" className="ext-secondary-btn" disabled={busy || !source.trim()}>{busy && !preview ? copy.working : copy.preview}</button>
        </form>
        {preview && preview.upgrade && <UpgradePreview preview={preview} plan={preview.upgrade} copy={copy} language={language}
          busy={busy} onCancel={closeImport} onUpgrade={upgrade} />}
        {preview && !preview.upgrade && <div className="plugin-import-preview">
          <span className="plugin-import-kicker">{copy.previewKicker}</span>
          <article className={`plugin-card is-preview${preview.canEnable ? "" : " is-blocked"}`} aria-label={preview.name}>
            <div className="plugin-card-main">
              <span className="plugin-card-mark" aria-hidden="true">{monogram(preview.name)}</span>
              <PackageHeading item={preview} copy={copy} badge={preview.canEnable ? "compatible" : "blocked"} />
            </div>
            <Diagnostics item={preview} copy={copy} />
            <PackageDetails item={preview} copy={copy} language={language} />
          </article>
          <div className="plugin-import-actions">
            <p><SvgIcon name="shieldCheck" size={13} />{copy.previewNote}</p>
            <div>
              <button type="button" className="ext-secondary-btn" disabled={busy} onClick={closeImport}>{copy.cancel}</button>
              <button type="button" className="ext-primary-btn" disabled={busy} onClick={install}>{busy ? copy.working : copy.install}</button>
            </div>
          </div>
        </div>}
      </div>}
      {loading ? <div className="plugin-list" role="status" aria-label={copy.loading}>
        <div className="plugin-skeleton" /><div className="plugin-skeleton" />
      </div> : packages.length === 0 ? !importOpen && <div className="plugin-empty">
        <span className="plugin-empty-mark" aria-hidden="true"><SvgIcon name="grid" size={20} /></span>
        <strong>{copy.emptyTitle}</strong>
        <p>{copy.empty}</p>
        <button type="button" className="ext-secondary-btn" disabled={busy} onClick={openImport}><SvgIcon name="folder" size={14} />{copy.emptyAction}</button>
      </div> : <div className="plugin-list">
        {packages.map((item) => <InstalledCard key={item.name} item={item} copy={copy} language={language} busy={busy}
          checking={checking === item.name} onToggle={() => toggle(item)} onRemove={() => remove(item)} onCheck={() => checkMcp(item)} />)}
      </div>}
      {packages.length > 0 && <p className="plugin-footnote"><SvgIcon name="info" size={13} />{copy.nextRun}</p>}
    </>}
  </section>;
}
