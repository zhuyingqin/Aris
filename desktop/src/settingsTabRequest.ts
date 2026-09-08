/**
 * sessionStorage key + window event name used to hand a requested Settings
 * tab off from `App.tsx` to the (possibly not-yet-mounted) `Settings.tsx`.
 * Shared so both sides always agree on the same strings.
 */
export const SETTINGS_TAB_REQUEST_KEY = "somniq-settings-tab-request";
export const SETTINGS_TAB_REQUEST_EVENT = "somniq-settings-tab-request-event";
