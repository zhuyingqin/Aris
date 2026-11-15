import { useState } from "react";

import { SvgIcon, type SvgIconName } from "../SvgIcon";
import { useStore, type Language } from "../store";
import { OFFICIAL_PLUGIN_NAMES, officialPluginsSet, switchTarget, type OfficialPluginId, type OfficialPluginState } from "./officialPlugins";
import "./PluginPackages.css";

const COPY = {
  cn: {
    title: "官方插件", kicker: "随应用发布",
    description: "这些模块随 SomniQ 一起发布，不需要批准。关掉用不到的模块，它的入口、工具和后台服务会一起停用，模型也就看不到这些工具。",
    official: "官方", on: "已启用", off: "已关闭", alwaysOn: "始终启用",
    alwaysOnHint: "这一版还不能单独关闭。",
    enable: "启用", disable: "关闭",
    nextRun: "开关从下一轮对话起生效，正在进行的对话不受影响。",
    loading: "正在读取官方插件…",
    thisProject: "在本项目",
    followGlobal: (on: boolean) => `跟随全局（${on ? "开启" : "关闭"}）`,
    projectOn: "本项目开启", projectOff: "本项目关闭",
    workspaceOff: "这个项目的 .somniq/plugins/official.json 要求关闭；在本项目单独开启可以覆盖。",
    projectOverride: "本项目使用单独的设置。",
    names: OFFICIAL_PLUGIN_NAMES.cn,
    descriptions: {
      literature: "外部文献检索、检索协议、PDF 获取和文献库页面。本地证据检索（项目文献、PDF、已确认知识）属于核心功能，关掉也保留；综述流程需要它。",
      latex: "Typeset 编辑器、LaTeX 编译与渲染工具和 TikZ 绘图指引。关闭后 .tex 文件改在 Code 页打开。",
      figures: "科研绘图页面：论文插图的生成、审阅与编辑。关闭后不能在本项目发起新的绘图请求。",
      mail: "连接 Gmail、Outlook 或 IMAP 邮箱。包括邮件工具、新邮件监听和定时任务的“新邮件”触发；关闭后这些会一起停用，邮箱账号保留。新邮件监听只看全局开关。",
    },
  },
  en: {
    title: "Official plugins", kicker: "Ships with the app",
    description: "These modules ship with SomniQ and need no approval. Turn off a module you don't use and its entry, tools and background services stop together, so the model no longer sees those tools.",
    official: "Official", on: "On", off: "Off", alwaysOn: "Always on",
    alwaysOnHint: "This version cannot turn it off yet.",
    enable: "Turn on", disable: "Turn off",
    nextRun: "A switch takes effect from the next turn; a turn in progress keeps what it started with.",
    loading: "Loading official plugins…",
    thisProject: "In this project",
    followGlobal: (on: boolean) => `Follow global (${on ? "on" : "off"})`,
    projectOn: "On in this project", projectOff: "Off in this project",
    workspaceOff: "This project's .somniq/plugins/official.json asks for it off; turning it on for this project overrides that.",
    projectOverride: "This project uses its own setting.",
    names: OFFICIAL_PLUGIN_NAMES.en,
    descriptions: {
      literature: "External literature search, search protocols, PDF acquisition and the library page. Local evidence retrieval (project papers, PDFs, confirmed knowledge) is core and stays when this is off; literature reviews need it.",
      latex: "The Typeset editor, the LaTeX compile and render tools and TikZ diagram guidance. When it is off, .tex files open in Code.",
      figures: "The Figures page: generating, reviewing and editing paper figures. When it is off, this project cannot start new figure requests.",
      mail: "Connect Gmail, Outlook or IMAP mailboxes: the mail tools, new-mail watching and the scheduled tasks' new-mail trigger. Turning it off stops all of them; your accounts are kept. New-mail watching follows the global switch only.",
    },
  },
} as const;

const ICONS: Record<OfficialPluginId, SvgIconName> = {
  literature: "library", latex: "document", figures: "image", mail: "inbox",
};

type ProjectChoice = "follow" | "on" | "off";
const projectChoice = (state: OfficialPluginState): ProjectChoice =>
  state.project === null ? "follow" : state.project ? "on" : "off";

/** The official plugins on the Plugins page: same card as a package, no approval. */
export default function OfficialPluginsSection({ language }: { language: Language }) {
  const copy = COPY[language];
  const states = useStore((state) => state.officialPlugins);
  const projectPath = useStore((state) => state.currentProject?.path);
  const apply = useStore((state) => state.applyOfficialPlugins);
  const setHideMail = useStore((state) => state.setHideMail);
  const setError = useStore((state) => state.setError);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  // Mail's switch goes through the store, which also keeps `hideMail` (the
  // navigation and settings view of it) in step.
  const toggle = (item: OfficialPluginState) => run(async () => {
    if (item.id === "mail") {
      await setHideMail(item.enabled);
    } else if (projectPath) {
      apply(await officialPluginsSet(projectPath, item.id, switchTarget(item), !item.enabled));
    }
  });

  const chooseForProject = (item: OfficialPluginState, choice: ProjectChoice) => run(async () => {
    if (!projectPath) return;
    const value = choice === "follow" ? null : choice === "on";
    apply(await officialPluginsSet(projectPath, item.id, "project", value));
  });

  return <section className="ext-section plugin-packages official-plugins" aria-label={copy.title} aria-busy={busy}>
    <div className="ext-section-head">
      <div>
        <span className="ext-section-kicker">{copy.kicker}</span>
        <h2>{copy.title}</h2>
        <p className="ext-section-sub">{copy.description}</p>
      </div>
    </div>
    {!states ? <div className="ext-empty">{copy.loading}</div> : <>
      <div className="plugin-list">
        {states.map((item) => {
          const name = copy.names[item.id];
          const label = !item.toggleable ? copy.alwaysOn : item.enabled ? copy.on : copy.off;
          const globalOn = item.globalEnabled;
          return <article key={item.id} aria-label={name}
            className={`plugin-card is-${item.enabled ? "enabled" : "disabled"}`}>
            <div className="plugin-card-main">
              <span className="plugin-card-mark" aria-hidden="true"><SvgIcon name={ICONS[item.id]} size={16} /></span>
              <div className="plugin-card-copy">
                <div className="plugin-card-title">
                  <strong>{name}</strong>
                  <span className="plugin-badge">{copy.official}</span>
                </div>
                <p className="plugin-card-desc">{copy.descriptions[item.id]}</p>
                {!item.toggleable && <p className="plugin-card-desc">{copy.alwaysOnHint}</p>}
                {item.toggleable && <div className="plugin-card-meta">
                  <label className="official-plugin-scope">
                    <span>{copy.thisProject}</span>
                    <select value={projectChoice(item)} disabled={busy || !projectPath}
                      onChange={(event) => void chooseForProject(item, event.target.value as ProjectChoice)}>
                      <option value="follow">{copy.followGlobal(globalOn)}</option>
                      <option value="on">{copy.projectOn}</option>
                      <option value="off">{copy.projectOff}</option>
                    </select>
                  </label>
                </div>}
                {item.toggleable && item.workspaceOff && item.project === null
                  && <p className="plugin-card-desc">{copy.workspaceOff}</p>}
                {item.toggleable && item.project !== null && <p className="plugin-card-desc">{copy.projectOverride}</p>}
              </div>
              <div className="plugin-card-controls">
                <span className="plugin-state">{label}</span>
                <button type="button" role="switch" className="plugin-switch" aria-checked={item.enabled}
                  aria-label={`${item.enabled ? copy.disable : copy.enable} ${name}`}
                  disabled={busy || !item.toggleable} onClick={() => void toggle(item)}><span /></button>
              </div>
            </div>
          </article>;
        })}
      </div>
      <p className="plugin-footnote"><SvgIcon name="info" size={13} />{copy.nextRun}</p>
    </>}
  </section>;
}
