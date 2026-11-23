import type { ReactNode } from "react";

import { ModuleIcon } from "../ModuleIcon";
import type { Tab } from "../store";
import type { OfficialPluginId } from "./officialPlugins";

/** A navigation entry an official plugin contributes (its `nav` contribution). */
export interface OfficialPluginNavItem {
  plugin: OfficialPluginId;
  id: Tab;
  /** Fallback label; the app shell shows its localized `copy.nav[id]`. */
  label: string;
  /** Position among all primary modules, core ones included. */
  order: number;
  icon: ReactNode;
}

export const OFFICIAL_PLUGIN_NAV_ITEMS: OfficialPluginNavItem[] = [
  {
    plugin: "figures", id: "figures", order: 20, label: "Figures",
    icon: <ModuleIcon><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m5 17 5-6 4 3 3-5 3 8" /><circle cx="8" cy="7" r="1" /></ModuleIcon>,
  },
  {
    plugin: "latex", id: "typeset", order: 30, label: "LaTeX",
    icon: <ModuleIcon>
      {/* TeX's lowered E makes the editor recognizable without relying on a font. */}
      <g fill="currentColor" stroke="none">
        <path d="M.8 4.5h8.5v3.2H8V6H5.9v10.2h1.5v1.4H2.8v-1.4h1.5V6H2.1v1.7H.8Z" />
        <path d="M8 7.5h7v2.8h-1.2V9h-3.3v3.9h2.6v-1.2h1.1v3.8h-1.1v-1.2h-2.6v4.3h3.3v-1.4H15V20H8v-1.4h1V9H8Z" />
        <path d="M15 4.5h3.6v1.4h-1l2.2 4.2L22 5.9h-1V4.5h3v1.4h-.6l-2.7 5 2.8 5.3h.5v1.4h-3.6v-1.4h1.1l-2.1-4.1-2.2 4.1h1.1v1.4H15v-1.4h.8l2.8-5.3-2.7-5H15Z" />
      </g>
    </ModuleIcon>,
  },
  {
    plugin: "literature", id: "literature", order: 50, label: "Literature",
    icon: <ModuleIcon>
      <path d="M12 5.5C9.5 3.5 5.5 3.2 2.5 4.3v15C6 18.1 9.5 18.5 12 20.5c2.5-2 6-2.4 9.5-1.2v-15C18.5 3.2 14.5 3.5 12 5.5Zm0 0v15" />
      <path d="m5.5 8 3.5.7M15 8.7l3.5-.7" />
    </ModuleIcon>,
  },
  {
    plugin: "mail", id: "mail", order: 80, label: "Mail",
    icon: <ModuleIcon>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="m3.5 6 8.5 6.5L20.5 6" />
    </ModuleIcon>,
  },
];
