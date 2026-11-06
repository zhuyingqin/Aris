import { useCallback, useEffect, useRef, useState } from "react";
import { PLUGINS_CHANGED_EVENT, pluginsUiList, type ActiveUiPanel, type UiText } from "../api/plugins";
import { hasNativeBackend } from "../api/transport";
import type { Language } from "../store";
import { UiListSlot } from "./uiSlots";

export const uiText = (text: UiText, language: Language) => typeof text === "string" ? text : text[language];
export const uiPanelKey = (panel: Pick<ActiveUiPanel, "pluginName" | "id">) =>
  `plugin:${encodeURIComponent(panel.pluginName)}:${encodeURIComponent(panel.id)}`;

export function useChatPluginPanels(projectPath: string | undefined) {
  const [result, setResult] = useState<{ project?: string; panels: ActiveUiPanel[]; error: string; loaded: boolean }>({ panels: [], error: "", loaded: false });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!projectPath || !hasNativeBackend()) {
      setResult({ project: projectPath, panels: [], error: "", loaded: true });
      return;
    }
    try {
      const panels = await pluginsUiList(projectPath);
      const slot = new UiListSlot<ActiveUiPanel>("chat.sidebar");
      for (const panel of panels) slot.register(panel.slot, uiPanelKey(panel), panel.order, panel);
      if (generation.current === request) setResult({ project: projectPath, panels: slot.values(), error: "", loaded: true });
    } catch (error) {
      // On a failed refresh stop presenting stale contributions. Stored user
      // data stays on disk and the existing tab can offer a retry.
      if (generation.current === request) setResult({ project: projectPath, panels: [], error: String(error), loaded: true });
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === projectPath) void refresh();
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
    : { panels: [], error: "", loaded: false, refresh };
}
