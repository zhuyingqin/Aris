/**
 * sessionStorage key + window event name used to hand a requested Settings
 * tab off from `App.tsx` to the (possibly not-yet-mounted) `Settings.tsx`.
 * Shared so both sides always agree on the same strings.
 */
import { resolveSettingsPageId, type SettingsNavId, type SettingsPageId } from "./settings/settingsNav";

export type SettingsTabRequest = SettingsNavId | "membership";

export function resolveSettingsTabRequest(value: unknown): SettingsPageId | "membership" | null {
  return value === "membership" ? "membership" : resolveSettingsPageId(value);
}

export const SETTINGS_TAB_REQUEST_KEY = "somniq-settings-tab-request";
export const SETTINGS_TAB_REQUEST_EVENT = "somniq-settings-tab-request-event";
