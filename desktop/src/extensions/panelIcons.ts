import type { SvgIconName } from "../SvgIcon";

/**
 * The host icons a plugin panel may name: the backend's `UI_ICONS`
 * (crates/runtime/src/plugins/ui.rs), in the same order. `panelIcons.test.ts`
 * fails when the two lists drift apart. Brand marks, chevrons and other
 * control glyphs stay out: a panel's icon names what it is, not an action.
 */
export const PANEL_ICONS: readonly SvgIconName[] = [
  "grid", "list", "target", "barChart", "lineChart", "graph", "document", "notebook", "folder",
  "clock", "star", "sparkle", "lightning", "library", "bookOpen", "code", "image", "search",
  "inbox", "collection", "memory", "diagram", "pin", "check",
  // Added with the larger set; the first 24 keep their order.
  "sprout", "leaf", "droplet", "flask", "database", "calendar", "bell", "flag", "globe", "cpu",
  "map", "home", "heart", "cloud", "tag", "box", "users",
  "settings", "user", "sun", "moon", "play", "quote", "messageCircle", "branch", "edit",
  "desktop", "phone", "shieldCheck", "refresh", "warning", "info", "filter", "attachment", "send",
];

/** The longest `iconPath` a panel may declare (the backend's `MAX_UI_ICON_PATH_CHARS`). */
export const MAX_ICON_PATH_CHARS = 1024;
const ICON_PATH = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;

/**
 * A panel's own outline on the host's 16 x 16 icon grid, or nothing. The
 * backend already refused anything else; this second look keeps a stale or
 * hand-edited listing from reaching the DOM.
 */
export const panelIconPath = (path: string | undefined): string | undefined =>
  path && path.length <= MAX_ICON_PATH_CHARS && ICON_PATH.test(path) && /\d/.test(path) ? path : undefined;
