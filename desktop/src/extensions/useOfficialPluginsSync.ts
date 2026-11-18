import { useEffect } from "react";

import { isTauri } from "../api/tauri";
import { listen } from "../api/transport";
import { useStore } from "../store";
import {
  migrateMailVisibility,
  OFFICIAL_PLUGINS_CHANGED_EVENT,
  officialPluginsList,
} from "./officialPlugins";

/**
 * Keep the store's view of the official plugins in step with the backend for
 * the current project: on project change and whenever a switch is flipped.
 * Mounted once, by the app shell.
 */
export function useOfficialPluginsSync() {
  const projectPath = useStore((state) => state.currentProject?.path);
  const apply = useStore((state) => state.applyOfficialPlugins);
  useEffect(() => {
    if (!isTauri() || !projectPath) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    const load = async () => {
      try {
        const states = await migrateMailVisibility(projectPath, await officialPluginsList(projectPath));
        if (alive) apply(states);
      } catch (error) {
        // A project switch in flight answers "Project changed"; the next
        // project's load follows. Anything else leaves the cached view.
        console.warn("SomniQ official plugins:", error);
      }
    };
    void load();
    void listen(OFFICIAL_PLUGINS_CHANGED_EVENT, () => void load()).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [projectPath, apply]);
}
