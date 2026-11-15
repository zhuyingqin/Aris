import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import type { Tab } from "../store";
import type { OfficialPluginId } from "./officialPlugins";

/** What the shell hands every official plugin page. */
export interface OfficialPageProps {
  /** The page's tab is the one on screen (a kept page stays mounted while hidden). */
  visible: boolean;
}

type PageComponent = ComponentType<OfficialPageProps>;

/** The page an official plugin contributes (its `pages` contribution). */
export interface OfficialPluginPage {
  plugin: OfficialPluginId;
  tab: Tab;
  /** Loads the page's module; also used to preload it on hover. */
  load: () => Promise<{ default: PageComponent }>;
  Component: LazyExoticComponent<PageComponent>;
  /**
   * `keep`: mounted on the first visit, then hidden rather than unmounted, so
   * unsaved work and running jobs survive tab switches. `visible`: mounted
   * only while its tab is shown.
   */
  mount: "keep" | "visible";
  /** Wrapper class for a kept page (the wrapper carries `hidden`). */
  paneClassName?: string;
  /** The page draws inside the navigation shell, like Chat and Settings. */
  navigationShell?: boolean;
}

const page = (def: Omit<OfficialPluginPage, "Component">): OfficialPluginPage => ({
  ...def,
  Component: lazy(def.load),
});

// Literature is not listed: its page view is shell state shared with the top
// bar's toolbar slot, so App.tsx still mounts it directly.
export const OFFICIAL_PLUGIN_PAGES: readonly OfficialPluginPage[] = [
  page({
    plugin: "latex", tab: "typeset", mount: "keep", paneClassName: "app-typeset-pane",
    load: () => import("../typeset/Typeset"),
  }),
  page({
    plugin: "figures", tab: "figures", mount: "keep", paneClassName: "app-figures-pane", navigationShell: true,
    load: () => import("../figures/FigureStudio"),
  }),
  page({
    plugin: "mail", tab: "mail", mount: "visible",
    load: () => import("../mail/Mail"),
  }),
];

export const officialPluginPage = (tab: string): OfficialPluginPage | null =>
  OFFICIAL_PLUGIN_PAGES.find((entry) => entry.tab === tab) ?? null;
