import type { UiPanel } from "../api/plugins";
import { SvgIcon } from "../SvgIcon";
import { panelIconPath } from "./panelIcons";
import { pluginPageIcon } from "./useChatPluginPanels";

/**
 * A plugin panel's icon wherever the app shows one: the panel's own outline
 * (`iconPath`) drawn like a host icon, else the host icon it names, else the
 * one its widgets suggest.
 */
export default function PluginPanelIcon({ panel, size = 16, className }: {
  panel: Pick<UiPanel, "widgets" | "icon" | "iconPath">; size?: number; className?: string;
}) {
  const path = panelIconPath(panel.iconPath);
  if (!path) return <SvgIcon name={pluginPageIcon(panel)} size={size} className={className} />;
  return <svg className={["svg-icon", className].filter(Boolean).join(" ")} width={size} height={size} viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth={1.45} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden focusable={false} data-icon="plugin-path">
    <path d={path} />
  </svg>;
}
