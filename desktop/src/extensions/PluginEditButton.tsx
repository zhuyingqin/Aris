// "Change this view": hands the panel to the agent to redesign. The click
// only drafts a prompt in the composer; the user says what they want and
// sends it. The agent checks out the installed package, edits it, and the
// change reaches the user as an upgrade card they can try before approving.
import type { ActiveUiPanel } from "../api/plugins";
import { SvgIcon } from "../SvgIcon";
import type { Language } from "../store";
import { tr } from "../language";
import { uiText } from "./useChatPluginPanels";
import "./PluginEditButton.css";

const SLOTS = {
  cn: { "nav.page": "导航栏页面", "chat.sidebar": "Chat 侧栏", "chat.brief": "项目摘要小组件" },
  en: { "nav.page": "navigation-rail page", "chat.sidebar": "Chat sidebar tab", "chat.brief": "project-summary glance" },
  es: { "nav.page": "página de la barra de navegación", "chat.sidebar": "pestaña lateral del Chat", "chat.brief": "vistazo del resumen del proyecto" },
} as const;

/** The composer text the button drafts: what to change is left for the user to write. */
export function pluginEditPrompt(panel: Pick<ActiveUiPanel, "pluginName" | "id" | "slot" | "title">, language: Language): string {
  const title = uiText(panel.title, language);
  const where = SLOTS[language][panel.slot] ?? panel.slot;
  return tr(
    language,
    `修改插件 ${panel.pluginName} 的“${title}”界面（面板 ${panel.id}，${where}）。先加载 somniq-plugin-development，用 PluginManager checkout 取出它当前安装的文件，按我的要求修改并提高版本号，预览没有诊断后用 upgrade 交给我审批；别改动我已有的数据。\n我想要：`,
    `Change the "${title}" view of plugin ${panel.pluginName} (panel ${panel.id}, ${where}). Load somniq-plugin-development, check out its installed files with PluginManager checkout, make my change and raise the version, preview until there are no diagnostics, then upgrade so I can approve it. Keep my existing data.\nWhat I want: `,
    `Cambia la vista "${title}" del plugin ${panel.pluginName} (panel ${panel.id}, ${where}). Carga somniq-plugin-development, extrae sus archivos instalados con PluginManager checkout, haz mi cambio y sube la versión, previsualiza hasta que no haya diagnósticos y luego usa upgrade para que pueda aprobarlo. Conserva mis datos actuales.\nLo que quiero: `,
  );
}

export default function PluginEditButton({ panel, language, onPrompt, compact = false }: {
  panel: Pick<ActiveUiPanel, "pluginName" | "id" | "slot" | "title">; language: Language;
  onPrompt: (text: string) => void;
  /** Icon only, for a tight header. */
  compact?: boolean;
}) {
  const label = tr(language, "改这个界面", "Change this view", "Cambiar esta vista");
  const hint = tr(language, "让 AI 按你的要求重新设计这个界面", "Ask the AI to redesign this view your way", "Pide a la IA que rediseñe esta vista a tu gusto");
  return <button type="button" className={`plugin-edit-button${compact ? " is-compact" : ""}`} title={hint} aria-label={compact ? label : undefined}
    onClick={() => onPrompt(pluginEditPrompt(panel, language))}>
    <SvgIcon name="edit" size={compact ? 12 : 13} />{compact ? null : <span>{label}</span>}
  </button>;
}
