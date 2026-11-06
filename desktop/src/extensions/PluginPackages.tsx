import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import {
  pluginsInstall, pluginsList, pluginsPreview, pluginsRemove, pluginsSetEnabled,
  type InstalledPlugin, type PluginPreview,
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
    nextRun: "Chat 面板启用后立即出现在 Chat 顶部的面板按钮和侧栏 + 菜单中；Skills 和 MCP 从下一次加载与执行开始生效。",
    previewNote: "安装后默认停用；启用时只接入当前项目，已有的本地 Skills 优先。",
    blockedTitle: "需要 DeepSeek 宿主能力",
    blockedNote: "此包依赖 SomniQ 尚未提供的宿主能力或配置，解决以下问题后才能启用。",
    confirmRemove: "移除后，此项目不再加载它的 Skills、MCP 和面板。会话中已保存的面板内容会保留。",
    confirm: "确认移除",
    enableMcpTitle: "启用后将在本机运行以下命令",
    enableMcpNote: "这些 MCP 服务会在每次对话开始时以你的身份启动，不在沙箱内运行。只启用你信任来源的插件包。",
    envKeys: "环境变量", confirmEnable: "确认启用",
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
    nextRun: "Enabled Chat panels appear right away in the Chat header and the sidebar + menu. Skills and MCP apply from the next load and run.",
    previewNote: "Packages install disabled and, once enabled, apply to this project only. Existing local Skills take priority.",
    blockedTitle: "Needs DeepSeek host capabilities",
    blockedNote: "This package relies on host capabilities or configuration SomniQ doesn't provide yet. Resolve these before enabling it.",
    confirmRemove: "This project will stop loading its Skills, MCP and panels. Panel content saved in conversations is kept.",
    confirm: "Remove package",
    enableMcpTitle: "Enabling runs these commands on this computer",
    enableMcpNote: "These MCP servers start as you at the beginning of every conversation and do not run in the sandbox. Only enable packages from sources you trust.",
    envKeys: "Environment", confirmEnable: "Enable package",
    noProject: "Select a project to manage packages.", retry: "Reload", loadFailed: "Couldn't load packages",
  },
};
type Copy = typeof COPY["cn"];

function splitName(name: string) {
  const slash = name.startsWith("@") ? name.indexOf("/") : -1;
  return slash > 0 ? { scope: name.slice(0, slash + 1), base: name.slice(slash + 1) } : { scope: "", base: name };
}

const monogram = (name: string) => (splitName(name).base.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

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

function Diagnostics({ item, copy }: { item: PluginPreview; copy: Copy }) {
  if (item.canEnable && item.diagnostics.length === 0) return null;
  return <div className={`plugin-callout ${item.canEnable ? "is-info" : "is-warning"}`}>
    <SvgIcon name={item.canEnable ? "info" : "warning"} size={15} />
    <div>
      {!item.canEnable && <><strong>{copy.blockedTitle}</strong><p>{copy.blockedNote}</p></>}
      {item.diagnostics.length > 0 && <ul>{item.diagnostics.map((diagnostic, index) =>
        <li key={`${diagnostic.code}-${index}`}><code>{diagnostic.code}</code><span>{diagnostic.message}</span></li>)}</ul>}
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

function InstalledCard({ item, copy, language, busy, onToggle, onRemove }: {
  item: InstalledPlugin; copy: Copy; language: Language; busy: boolean;
  onToggle: () => void; onRemove: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirming, setConfirming] = useState<"remove" | "enable" | null>(null);
  const detailsId = useId();
  const blocked = item.status === "blocked";
  const canToggle = item.enabled || item.canEnable;
  const stateLabel = item.enabled ? copy.enabled : blocked ? copy.cannotEnable : copy.disabled;
  const servers = item.capabilities.mcpServers;
  // Enabling a package that declares MCP servers starts local processes outside
  // the sandbox, so the exact commands are shown before the switch flips.
  const requestToggle = () => {
    if (!item.enabled && servers.length > 0) setConfirming((value) => value === "enable" ? null : "enable");
    else onToggle();
  };
  return <article className={`plugin-card is-${item.enabled ? "enabled" : blocked ? "blocked" : "disabled"}`} aria-label={item.name}>
    <div className="plugin-card-main">
      <span className="plugin-card-mark" aria-hidden="true">{blocked && !item.enabled ? <SvgIcon name="warning" size={16} /> : monogram(item.name)}</span>
      <PackageHeading item={item} copy={copy} badge={blocked ? "blocked" : undefined}>
        <button type="button" className="plugin-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen((value) => !value)}>
          {detailsOpen ? copy.hideDetails : copy.details}<SvgIcon name={detailsOpen ? "chevronUp" : "chevronDown"} size={12} />
        </button>
      </PackageHeading>
      <div className="plugin-card-controls">
        <span className="plugin-state">{stateLabel}</span>
        <button type="button" role="switch" className="plugin-switch" aria-checked={item.enabled}
          aria-label={`${item.enabled ? copy.disable : copy.enable} ${item.name}`}
          disabled={busy || !canToggle} onClick={requestToggle}><span /></button>
        <button type="button" className="plugin-icon-btn is-danger" aria-label={`${copy.remove} ${item.name}`} title={copy.remove}
          disabled={busy} aria-expanded={confirming === "remove"} onClick={() => setConfirming((value) => value === "remove" ? null : "remove")}><SvgIcon name="trash" size={14} /></button>
      </div>
    </div>
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

export default function PluginPackages({ projectPath, language, onChanged }: {
  projectPath: string | undefined;
  language: Language;
  onChanged: () => void;
}) {
  const copy = COPY[language];
  const [packages, setPackages] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const epoch = useRef(0);
  const sourceInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const request = ++epoch.current;
    setPackages([]); setPreview(null); setSource(""); setError(""); setBusy(false); setImportOpen(false);
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

  function install() {
    if (!projectPath || !preview) return;
    const request = epoch.current;
    bound(async () => {
      const result = await pluginsInstall(projectPath, preview.source, preview.digest);
      if (epoch.current !== request) return;
      setPackages((items) => [...items, result].sort((a, b) => a.name.localeCompare(b.name)));
      setPreview(null); setSource(""); setImportOpen(false); onChanged();
    });
  }

  function toggle(item: InstalledPlugin) {
    if (!projectPath) return;
    const request = epoch.current;
    bound(async () => {
      const result = await pluginsSetEnabled(projectPath, item.name, !item.enabled);
      if (epoch.current !== request) return;
      setPackages((items) => items.map((entry) => entry.name === item.name ? result : entry)); onChanged();
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
        {preview && <div className="plugin-import-preview">
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
          onToggle={() => toggle(item)} onRemove={() => remove(item)} />)}
      </div>}
      {packages.length > 0 && <p className="plugin-footnote"><SvgIcon name="info" size={13} />{copy.nextRun}</p>}
    </>}
  </section>;
}
