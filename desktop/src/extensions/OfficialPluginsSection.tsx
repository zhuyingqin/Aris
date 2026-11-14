import { useState } from "react";

import { SvgIcon, type SvgIconName } from "../SvgIcon";
import { useStore, type Language } from "../store";
import type { OfficialPluginId, OfficialPluginState } from "./officialPlugins";
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
    names: { literature: "文献库", latex: "LaTeX", figures: "Figures", mail: "邮箱" },
    descriptions: {
      literature: "文献检索、文献库页面和证据检索工具。",
      latex: "Typeset 编辑器，以及 LaTeX 编译与渲染工具。",
      figures: "论文插图的生成与编辑。",
      mail: "连接 Gmail、Outlook 或 IMAP 邮箱。包括邮件工具、新邮件监听和定时任务的“新邮件”触发；关闭后这些会一起停用，邮箱账号保留。",
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
    names: { literature: "Literature", latex: "LaTeX", figures: "Figures", mail: "Mail" },
    descriptions: {
      literature: "Literature search, the library page and evidence retrieval tools.",
      latex: "The Typeset editor and the LaTeX compile and render tools.",
      figures: "Generating and editing paper figures.",
      mail: "Connect Gmail, Outlook or IMAP mailboxes: the mail tools, new-mail watching and the scheduled tasks' new-mail trigger. Turning it off stops all of them; your accounts are kept.",
    },
  },
} as const;

const ICONS: Record<OfficialPluginId, SvgIconName> = {
  literature: "library", latex: "document", figures: "image", mail: "inbox",
};

/** The official plugins on the Plugins page: same card as a package, no approval. */
export default function OfficialPluginsSection({ language }: { language: Language }) {
  const copy = COPY[language];
  const states = useStore((state) => state.officialPlugins);
  const setHideMail = useStore((state) => state.setHideMail);
  const setError = useStore((state) => state.setError);
  const [busy, setBusy] = useState(false);

  const toggle = async (item: OfficialPluginState) => {
    if (item.id !== "mail") return;
    setBusy(true);
    try {
      await setHideMail(item.enabled);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

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
