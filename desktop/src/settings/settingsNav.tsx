import type { ReactNode } from "react";
import type { Language } from "../store";
import { SETTINGS_COPY } from "./i18n";

/**
 * Left-sidebar navigation model for the Settings surface. The settings page was
 * reworked from a horizontal tab bar into a grouped sidebar + content pane
 * (mirrors the reference design); this module owns the nav taxonomy, icons,
 * and localized labels so `Settings.tsx` stays focused on section content.
 */
export type SettingsNavId =
  | "profile"
  | "general"
  | "account"
  | "models"
  | "memory"
  | "mail"
  | "remote"
  | "extensions"
  | "environment"
  | "about";

export type SettingsNavGroupId = "personal" | "integration" | "system";

export interface SettingsNavItemDef {
  id: SettingsNavId;
  icon: ReactNode;
  /** Renders a trailing ↗ affordance (e.g. account opens the gateway). */
  external?: boolean;
}

export interface SettingsNavGroupDef {
  id: SettingsNavGroupId;
  items: SettingsNavItemDef[];
}

const svg = (children: ReactNode): ReactNode => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.45"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const NAV_ICONS: Record<SettingsNavId, ReactNode> = {
  profile: svg(
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="6.3" r="1.8" />
      <path d="M4.8 12c.8-1.7 5.6-1.7 6.4 0" />
    </>,
  ),
  general: svg(
    <>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.8v1.5M8 12.7v1.5M14.2 8h-1.5M3.3 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7l-1.1-1.1" />
    </>,
  ),
  extensions: svg(
    <path d="M6 2.5H3.5a1 1 0 00-1 1V6M10 2.5h2.5a1 1 0 011 1V6M6 13.5H3.5a1 1 0 01-1-1V10M10 13.5h2.5a1 1 0 001-1V10M6.2 6.2h3.6v3.6H6.2z" />,
  ),
  account: svg(
    <>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.6" />
      <circle cx="6" cy="7" r="1.5" />
      <path d="M3.7 11c.4-1.4 4-1.4 4.4 0M9.4 6.4h2.9M9.4 8.6h2.9M9.4 10.4h1.8" />
    </>,
  ),
  models: svg(
    <>
      <path d="M8 2.6 13.4 8 8 13.4 2.6 8z" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </>,
  ),
  memory: svg(
    <>
      <ellipse cx="8" cy="4" rx="4.8" ry="2" />
      <path d="M3.2 4v4c0 1.1 2.1 2 4.8 2s4.8-.9 4.8-2V4M3.2 8v4c0 1.1 2.1 2 4.8 2s4.8-.9 4.8-2V8" />
    </>,
  ),
  mail: svg(
    <>
      <rect x="2.2" y="4" width="11.6" height="8" rx="1.2" />
      <path d="M2.6 4.6 8 8.6l5.4-4" />
    </>,
  ),
  remote: svg(
    <>
      <rect x="2.2" y="2.7" width="11.6" height="8.1" rx="1.3" />
      <path d="M5.5 13.3h5M8 10.8v2.5" />
    </>,
  ),
  environment: svg(
    <>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.4" />
      <path d="M4.4 6.4 6.4 8l-2 1.6M8.4 9.6h3" />
    </>,
  ),
  about: svg(
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.3v3.4M8 5.2h.01" />
    </>,
  ),
};

export const SETTINGS_NAV_GROUPS: SettingsNavGroupDef[] = [
  {
    id: "personal",
    items: [
      { id: "profile", icon: NAV_ICONS.profile },
      { id: "general", icon: NAV_ICONS.general },
      { id: "account", icon: NAV_ICONS.account },
    ],
  },
  {
    id: "integration",
    items: [
      { id: "models", icon: NAV_ICONS.models },
      { id: "memory", icon: NAV_ICONS.memory },
      { id: "extensions", icon: NAV_ICONS.extensions },
      { id: "mail", icon: NAV_ICONS.mail },
      { id: "remote", icon: NAV_ICONS.remote },
    ],
  },
  {
    id: "system",
    items: [
      { id: "environment", icon: NAV_ICONS.environment },
      { id: "about", icon: NAV_ICONS.about },
    ],
  },
];

export const SETTINGS_NAV_LABELS: Record<Language, Record<SettingsNavId, string>> = {
  cn: SETTINGS_COPY.cn.nav.labels,
  en: SETTINGS_COPY.en.nav.labels,
};

export const SETTINGS_NAV_GROUP_LABELS: Record<Language, Record<SettingsNavGroupId, string>> = {
  cn: SETTINGS_COPY.cn.nav.groupLabels,
  en: SETTINGS_COPY.en.nav.groupLabels,
};

export const SETTINGS_NAV_MISC: Record<Language, { back: string }> = {
  cn: SETTINGS_COPY.cn.nav.misc,
  en: SETTINGS_COPY.en.nav.misc,
};

const SETTINGS_NAV_ID_SET = new Set<SettingsNavId>(
  SETTINGS_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
);

export function isSettingsNavId(value: unknown): value is SettingsNavId {
  return typeof value === "string" && SETTINGS_NAV_ID_SET.has(value as SettingsNavId);
}

/**
 * Map legacy deep-link tab ids (used by `App.tsx` and older sessionStorage
 * requests) onto the new nav ids so existing entry points keep working.
 */
export function resolveLegacySettingsNav(value: string | null | undefined): SettingsNavId | null {
  if (!value) return null;
  if (isSettingsNavId(value)) return value;
  switch (value) {
    case "appearance":
    case "shortcuts":
      return "general";
    case "auth":
    case "usage":
      return "account";
    case "models":
      return "models";
    default:
      return null;
  }
}
