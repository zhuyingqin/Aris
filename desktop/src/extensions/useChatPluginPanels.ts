import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeBackendPluginChanges, PLUGINS_CHANGED_EVENT, pluginsUiList, samePluginProject, type ActiveUiPanel, type UiPanel, type UiText } from "../api/plugins";
import type { SvgIconName } from "../SvgIcon";
import { hasNativeBackend } from "../api/transport";
import type { Language } from "../store";
import { UiListSlot } from "./uiSlots";

export const uiText = (text: UiText, language: Language) => typeof text === "string" ? text : text[language];
/** A panel has no icon of its own; its first interactive widget names it best. */
export const uiPanelIcon = (panel: Pick<UiPanel, "widgets">): SvgIconName => {
  const widget = panel.widgets.find((item) => item.type !== "text");
  return widget?.type === "todo-list" || widget?.type === "list" ? "list" : widget?.type === "notes" ? "notebook"
    : widget?.type === "agent-plan" || widget?.type === "metrics" ? "target" : widget?.type === "chart" ? (widget.chart === "bar" ? "barChart" : "lineChart")
    : widget?.type === "markdown" ? "document" : widget?.type === "form" ? "edit" : "grid";
};
/** The icons a panel may name (the backend's `UI_ICONS`); anything else falls back. */
const PANEL_ICONS: readonly SvgIconName[] = ["grid", "list", "target", "barChart", "lineChart", "graph", "document", "notebook", "folder",
  "clock", "star", "sparkle", "lightning", "library", "bookOpen", "code", "image", "search", "inbox", "collection", "memory", "diagram", "pin", "check"];
export const pluginPageIcon = (panel: Pick<UiPanel, "widgets" | "icon">): SvgIconName =>
  PANEL_ICONS.find((icon) => icon === panel.icon) ?? uiPanelIcon(panel);
/** A click on a plugin page, handed to Chat: the page itself runs nothing. */
export const PLUGIN_PAGE_ACTION_EVENT = "somniq:plugin-page-action";
export type PluginPageAction = { type: "prompt"; text: string; send: boolean } | { type: "open-file"; path: string }
  /** Open a `nav.page` panel of the same package. */
  | { type: "open-panel"; pluginName: string; panelId: string };
/** Asks the app to show a plugin's page; the app ignores a key it has no page for. */
export const PLUGIN_OPEN_PAGE_EVENT = "somniq:plugin-open-page";
export function requestPluginPage(pluginName: string, panelId: string) {
  window.dispatchEvent(new CustomEvent<string>(PLUGIN_OPEN_PAGE_EVENT, { detail: uiPanelKey({ pluginName, id: panelId }) }));
}
/** How many plugin pages get a rail button of their own; the rest go under More. */
export const RAIL_PLUGIN_PAGES = 3;

export const uiPanelKey = (panel: Pick<ActiveUiPanel, "pluginName" | "id">) =>
  `plugin:${encodeURIComponent(panel.pluginName)}:${encodeURIComponent(panel.id)}`;

/** The enabled plugin panels of one slot: the Chat sidebar's tabs, or the rail's pages. */
export function useChatPluginPanels(projectPath: string | undefined, slotName: UiPanel["slot"] = "chat.sidebar") {
  // `all`: every slot's panels, for a panel that shows another one's data.
  const [result, setResult] = useState<{ project?: string; panels: ActiveUiPanel[]; all: ActiveUiPanel[]; error: string; loaded: boolean }>({ panels: [], all: [], error: "", loaded: false });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!projectPath || !hasNativeBackend()) {
      setResult({ project: projectPath, panels: [], all: [], error: "", loaded: true });
      return;
    }
    try {
      const panels = await pluginsUiList(projectPath);
      const slot = new UiListSlot<ActiveUiPanel>(slotName);
      for (const panel of panels) if (panel.slot === slotName) slot.register(panel.slot, uiPanelKey(panel), panel.order, panel);
      if (generation.current === request) setResult({ project: projectPath, panels: slot.values(), all: panels, error: "", loaded: true });
    } catch (error) {
      // On a failed refresh stop presenting stale contributions. Stored user
      // data stays on disk and the existing tab can offer a retry.
      if (generation.current === request) setResult({ project: projectPath, panels: [], all: [], error: String(error), loaded: true });
    }
  }, [projectPath, slotName]);

  useEffect(() => {
    void refresh();
    // An agent or an approval card can change plugins too.
    bridgeBackendPluginChanges();
    const changed = (event: Event) => {
      if (samePluginProject((event as CustomEvent<string>).detail, projectPath)) void refresh();
    };
    window.addEventListener(PLUGINS_CHANGED_EVENT, changed);
    window.addEventListener("focus", refresh);
    return () => {
      ++generation.current;
      window.removeEventListener(PLUGINS_CHANGED_EVENT, changed);
      window.removeEventListener("focus", refresh);
    };
  }, [projectPath, refresh]);

  return result.project === projectPath ? { ...result, refresh }
    : { panels: [] as ActiveUiPanel[], all: [] as ActiveUiPanel[], error: "", loaded: false, refresh };
}
