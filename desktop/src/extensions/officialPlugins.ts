// Official plugins: modules compiled into SomniQ (mail, figures, literature,
// LaTeX) that share the plugin switch and run freeze with user packages.
// Backend: runtime::plugins::builtin + desktop official_plugins.rs. Design:
// docs/development-logic/official-plugins.md.
import { invoke } from "../api/transport";

export type OfficialPluginId = "literature" | "latex" | "figures" | "mail";

export interface OfficialPluginState {
  id: OfficialPluginId;
  scope: "user" | "project";
  /** False while the module's seams are not behind the registry yet. */
  toggleable: boolean;
  /** What a turn starting now in this project gets. */
  enabled: boolean;
  global: boolean | null;
  project: boolean | null;
}

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
