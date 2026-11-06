import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import {
  pluginsInstall, pluginsList, pluginsPreview, pluginsRemove, pluginsSetEnabled,
  type InstalledPlugin, type PluginPreview,
} from "../api/plugins";
import { SvgIcon } from "../SvgIcon";
import type { Language } from "../store";
import { uiText } from "./useChatPluginPanels";
import "./PluginPackages.css";

const COPY = {
  cn: {
    title: "插件包", scope: "本项目", description: "导入本地插件包，添加 Skills、MCP 和自定义 Chat 面板。",
    add: "导入本地插件包", path: "插件包目录", placeholder: "选择包含 package.json 的本地目录", browse: "选择目录",
    preview: "预览", install: "安装并保持停用", cancel: "取消", refresh: "刷新插件包",
    loading: "正在读取插件包…", working: "处理中…", empty: "尚未安装插件包。导入前可以查看来源、版本和能力。",
    enable: "启用", disable: "停用", remove: "移除", details: "来源与兼容性", source: "本地来源", snapshot: "文件快照",
    skills: "Skills", mcp: "MCP", ui: "Chat 面板", none: "无", compatible: "可接入", blocked: "需要适配", enabled: "已启用", disabled: "已停用",
    nextRun: "Chat 面板启停后即可使用，在 Chat 顶部面板按钮或侧栏 + 中打开。Skills/MCP 在后续加载与执行时生效。",
    previewNote: "安装后默认停用；启用时接入当前项目。已有本地 Skills 优先。",
    blockedNote: "此包包含需要 DeepSeek 宿主的能力或配置，解决兼容性问题后才能启用。",
    noProject: "选择项目后管理插件包。", retry: "重新加载",
  },
  en: {
    title: "Plugin packages", scope: "This project", description: "Import local packages to add Skills, MCP and custom Chat panels.",
    add: "Import local package", path: "Package directory", placeholder: "Local directory containing package.json", browse: "Choose directory",
    preview: "Preview", install: "Install disabled", cancel: "Cancel", refresh: "Refresh packages",
    loading: "Loading packages…", working: "Working…", empty: "No packages installed. Preview the source, version and capabilities before importing.",
    enable: "Enable", disable: "Disable", remove: "Remove", details: "Source and compatibility", source: "Local source", snapshot: "File snapshot",
    skills: "Skills", mcp: "MCP", ui: "Chat panels", none: "None", compatible: "Compatible", blocked: "Needs adaptation", enabled: "Enabled", disabled: "Disabled",
    nextRun: "Open enabled panels from the Chat header or the sidebar + menu. Skills/MCP changes apply to subsequent loading and runs.",
    previewNote: "Packages start disabled and apply to this project when enabled. Existing local Skills take priority.",
    blockedNote: "This package requires DeepSeek host capabilities or configuration. Resolve the compatibility diagnostics before enabling it.",
    noProject: "Select a project to manage packages.", retry: "Reload",
  },
};

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

  async function act(action: () => Promise<void>) {
    const request = epoch.current;
    setBusy(true); setError("");
    try { await action(); }
    catch (failure) { if (epoch.current === request) setError(String(failure)); }
    finally { if (epoch.current === request) setBusy(false); }
  }

  function bound(action: () => Promise<void>) { void act(action); }

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

  function metadata(item: PluginPreview) {
    return <>
      {item.description && <p className="ext-section-sub">{item.description}</p>}
      <dl className="plugin-package-meta">
        <div><dt>{copy.skills}</dt><dd>{item.capabilities.skills.join(", ") || copy.none}</dd></div>
        <div><dt>{copy.mcp}</dt><dd>{item.capabilities.mcpServers.map((server) => `${server.name} · ${server.command} ${server.args.join(" ")}`).join("; ") || copy.none}</dd></div>
        <div><dt>{copy.ui}</dt><dd>{item.capabilities.uiPanels.map((panel) => uiText(panel.title, language)).join(", ") || copy.none}</dd></div>
        <div><dt>{copy.source}</dt><dd>{item.source}</dd></div>
        <div><dt>{copy.snapshot}</dt><dd><code title={item.digest}>{item.digest.slice(0, 16)}</code></dd></div>
      </dl>
      {!item.canEnable && <p className="ext-section-sub">{copy.blockedNote}</p>}
      {item.diagnostics.length > 0 && <ul className="plugin-package-diagnostics">{item.diagnostics.map((diagnostic, index) =>
        <li key={`${diagnostic.code}-${index}`}><span>{diagnostic.code}</span> {diagnostic.message}</li>,
      )}</ul>}
    </>;
  }

  return <section className="ext-section plugin-packages" aria-label={copy.title} aria-busy={busy || loading}>
    <div className="ext-section-head">
      <div><span className="ext-section-kicker">{copy.scope}</span><h2>{copy.title}</h2></div>
      <div className="plugin-package-actions">
        <button type="button" className="ext-secondary-btn" disabled={busy || loading || !projectPath} onClick={refresh} aria-label={copy.refresh}><SvgIcon name="refresh" size={14} /></button>
        <button type="button" className="ext-primary-btn" disabled={busy || loading || !projectPath} onClick={() => { setImportOpen(true); setError(""); }}><SvgIcon name="plus" size={14} />{copy.add}</button>
      </div>
    </div>
    <p className="ext-section-sub">{copy.description}</p>
    {error && <div className="plugin-package-error" role="alert">{error} <button type="button" className="ext-link" disabled={busy} onClick={refresh}>{copy.retry}</button></div>}
    {!projectPath ? <p className="ext-empty">{copy.noProject}</p> : <>
      {importOpen && <div className="plugin-package-import">
        <label htmlFor="plugin-package-source">{copy.path}</label>
        <div className="plugin-package-input">
          <input id="plugin-package-source" value={source} disabled={busy} placeholder={copy.placeholder} onChange={(event) => { setSource(event.target.value); setPreview(null); }} />
          {"__TAURI_INTERNALS__" in window && <button type="button" className="ext-secondary-btn" disabled={busy} onClick={() => {
            const request = epoch.current;
            bound(async () => {
              const directory = await open({ directory: true, multiple: false });
              if (typeof directory === "string" && epoch.current === request) { setSource(directory); setPreview(null); }
            });
          }}>{copy.browse}</button>}
          <button type="button" className="ext-secondary-btn" disabled={busy || !source.trim()} onClick={inspect}>{busy ? copy.working : copy.preview}</button>
          <button type="button" className="ext-link" disabled={busy} onClick={() => { setImportOpen(false); setPreview(null); }}>{copy.cancel}</button>
        </div>
        {preview && <div className="plugin-package-preview">
          <div className="plugin-package-title"><strong>{preview.name}</strong><span>v{preview.version}</span><span className={`ext-status-badge ${preview.canEnable ? "ready" : "failed"}`}>{preview.canEnable ? copy.compatible : copy.blocked}</span></div>
          {metadata(preview)}
          <p className="ext-section-sub">{copy.previewNote}</p>
          <button type="button" className="ext-primary-btn" disabled={busy} onClick={install}>{busy ? copy.working : copy.install}</button>
        </div>}
      </div>}
      {loading ? <div className="ext-empty">{copy.loading}</div> : packages.length === 0 ? <div className="ext-empty">{copy.empty}</div> : <div className="plugin-package-list">
        {packages.map((item) => <article className="plugin-package" key={item.name}>
          <div className="plugin-package-row">
            <div className="plugin-package-title"><strong>{item.name}</strong><span>v{item.version}</span><span className={`ext-status-badge ${item.status === "blocked" ? "failed" : item.enabled ? "ready" : "configured"}`}>{copy[item.status]}</span></div>
            <div className="plugin-package-actions">
              <button type="button" className="ext-secondary-btn" disabled={busy || (!item.enabled && !item.canEnable)} onClick={() => toggle(item)} aria-label={`${item.enabled ? copy.disable : copy.enable} ${item.name}`}>{item.enabled ? copy.disable : copy.enable}</button>
              <button type="button" className="ext-link" disabled={busy} onClick={() => remove(item)} aria-label={`${copy.remove} ${item.name}`}>{copy.remove}</button>
            </div>
          </div>
          <p className="ext-section-sub">{item.capabilities.skills.length} Skills · {item.capabilities.mcpServers.length} MCP · {item.capabilities.uiPanels.length} {copy.ui}</p>
          <details open={item.status === "blocked"}><summary>{copy.details}</summary>{metadata(item)}</details>
        </article>)}
      </div>}
      {packages.length > 0 && <p className="ext-section-sub">{copy.nextRun}</p>}
    </>}
  </section>;
}
