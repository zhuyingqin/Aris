// Official plugins: modules compiled into SomniQ (mail, figures, literature,
// LaTeX) that share the plugin switch and run freeze with user packages.
// Backend: runtime::plugins::builtin + desktop official_plugins.rs. Design:
// docs/development-logic/official-plugins.md.
import { invoke } from "../api/transport";
import type { Language, Tab } from "../store";

export type OfficialPluginId = "literature" | "latex" | "figures" | "mail";

export interface OfficialPluginState {
  id: OfficialPluginId;
  scope: "user" | "project";
  /** False while the module's seams are not behind the registry yet. */
  toggleable: boolean;
  /** What a turn starting now in this project gets. */
  enabled: boolean;
  global: boolean | null;
  /** What following the global switch gives (its choice or the default). */
  globalEnabled: boolean;
  /** This computer's override for the current project. */
  project: boolean | null;
  /** The project's own `.somniq/plugins/official.json` asks for it off. */
  workspaceOff: boolean;
}

/**
 * Where a plain on/off click should write. A project-scoped plugin (Figures,
 * LaTeX, Literature) is switched for this project only. A user-scoped one
 * (Mail) is switched globally, unless this project has its own setting or
 * asks for it off, where the global switch would be outranked.
 */
export const switchTarget = (state: OfficialPluginState): "global" | "project" =>
  state.scope === "project" || state.project !== null || state.workspaceOff ? "project" : "global";

/** Display names, shared by the official section and user packages that require one. */
export const OFFICIAL_PLUGIN_NAMES: Record<Language, Record<OfficialPluginId, string>> = {
  cn: { literature: "文献库", latex: "LaTeX", figures: "Figures", mail: "邮箱" },
  en: { literature: "Literature", latex: "LaTeX", figures: "Figures", mail: "Mail" },
  es: { literature: "Bibliografía", latex: "LaTeX", figures: "Figures", mail: "Correo" },
};

export const officialPluginName = (id: string, language: Language): string =>
  OFFICIAL_PLUGIN_NAMES[language][id as OfficialPluginId] ?? id;

export const OFFICIAL_PLUGINS_CHANGED_EVENT = "official-plugins-changed";

export const officialPluginsList = (projectPath: string) =>
  invoke<OfficialPluginState[]>("official_plugins_list", { projectPath });

export const officialPluginsSet = (
  projectPath: string,
  id: OfficialPluginId,
  target: "global" | "project",
  value: boolean | null,
) => invoke<OfficialPluginState[]>("official_plugins_set", { projectPath, id, target, value });

export const officialPluginEnabled = (states: OfficialPluginState[] | null, id: OfficialPluginId): boolean | null =>
  states?.find((state) => state.id === id)?.enabled ?? null;

/** Whether `.tex` files open in the LaTeX workspace (unknown counts as yes). */
export const latexWorkspaceOn = (states: OfficialPluginState[] | null): boolean =>
  officialPluginEnabled(states, "latex") !== false;

/** The page each official plugin contributes to the navigation. */
export const OFFICIAL_PLUGIN_TABS: Record<OfficialPluginId, Tab> = {
  literature: "literature", latex: "typeset", figures: "figures", mail: "mail",
};

export const officialTabPlugin = (tab: Tab): OfficialPluginId | null =>
  (Object.keys(OFFICIAL_PLUGIN_TABS) as OfficialPluginId[]).find((id) => OFFICIAL_PLUGIN_TABS[id] === tab) ?? null;

/**
 * Whether `tab` belongs to an official plugin that is off. Mail also answers
 * to `hideMail`, which mirrors its switch in the app and is a local
 * preference in the browser preview, where switches are unknown.
 */
export function officialTabHidden(tab: Tab, states: OfficialPluginState[] | null, hideMail: boolean): boolean {
  const plugin = officialTabPlugin(tab);
  if (!plugin) return false;
  if (plugin === "mail") return hideMail;
  return officialPluginEnabled(states, plugin) === false;
}

/** The navigation-visibility key mail used before it was a plugin. */
export const LEGACY_HIDE_MAIL_KEY = "somniq-hide-mail";
const MAIL_MIGRATION_KEY = "somniq-official-mail-migrated";

/**
 * Carry the old "show Mail" choice over once. The backend already seeded mail
 * from connected accounts (on when one exists), so the only choice left to
 * honour is an explicit "visible" on a profile without a mailbox.
 */
export async function migrateMailVisibility(
  projectPath: string,
  states: OfficialPluginState[],
): Promise<OfficialPluginState[]> {
  let migrated = false;
  let legacyVisible = false;
  try {
    migrated = localStorage.getItem(MAIL_MIGRATION_KEY) === "1";
    legacyVisible = localStorage.getItem(LEGACY_HIDE_MAIL_KEY) === "false";
  } catch {
    return states;
  }
  if (migrated) return states;
  let next = states;
  if (legacyVisible && officialPluginEnabled(states, "mail") === false) {
    next = await officialPluginsSet(projectPath, "mail", "global", true);
  }
  try {
    localStorage.setItem(MAIL_MIGRATION_KEY, "1");
  } catch {
    // Storage unavailable: the migration runs again next time, harmlessly.
  }
  return next;
}
