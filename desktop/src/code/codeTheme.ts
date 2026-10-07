/**
 * Translate SomniQ's own surface palette into VS Code colour IDs.
 *
 * The workbench runs in an iframe with its own stylesheet, so it cannot inherit
 * anything. Rather than keep a second copy of the palette in sync by hand, the
 * values are read out of the live document at push time: change `--bg` in
 * `styles.css` and the workbench follows on the next theme push.
 *
 * Syntax highlighting is deliberately not customised. SomniQ's `--code-*`
 * tokens are the Dark+/Light+ palettes already (see `styles.css`), which is
 * exactly what the base theme picked by `dark` gives us.
 */

/** SomniQ token → the VS Code colour IDs it should drive. */
const TOKEN_TARGETS: Record<string, readonly string[]> = {
  // The editing canvas and anything meant to read as "the page".
  "--bg": [
    "editor.background",
    "breadcrumb.background",
    "editorGutter.background",
    "panel.background",
    "tab.activeBackground",
    "terminal.background",
    "notebook.editorBackground",
  ],
  // One step up: chrome that frames the canvas.
  "--bg-1": [
    "activityBar.background",
    "editorGroupHeader.tabsBackground",
    "editorWidget.background",
    "menu.background",
    "notificationCenterHeader.background",
    "notifications.background",
    "quickInput.background",
    "sideBar.background",
    "sideBarSectionHeader.background",
    "statusBar.background",
    "statusBar.noFolderBackground",
    "tab.inactiveBackground",
    "titleBar.activeBackground",
    "titleBar.inactiveBackground",
    "welcomePage.background",
  ],
  // Controls and hover states.
  "--bg-2": [
    "dropdown.background",
    "input.background",
    "list.hoverBackground",
    "list.inactiveSelectionBackground",
    "toolbar.hoverBackground",
    "welcomePage.tileBackground",
  ],
  // The one selected row.
  "--bg-3": ["list.activeSelectionBackground", "welcomePage.tileHoverBackground"],
  "--border": [
    "activityBar.border",
    "dropdown.border",
    "editorGroup.border",
    "editorWidget.border",
    "input.border",
    "menu.border",
    "panel.border",
    "sideBar.border",
    "statusBar.border",
    "tab.border",
    "titleBar.border",
    "widget.border",
  ],
  "--text": [
    "activityBar.foreground",
    "editor.foreground",
    "foreground",
    "input.foreground",
    "list.activeSelectionForeground",
    "menu.foreground",
    "quickInput.foreground",
    "sideBar.foreground",
    "tab.activeForeground",
    "terminal.foreground",
    "titleBar.activeForeground",
  ],
  "--text-dim": [
    "activityBar.inactiveForeground",
    "breadcrumb.foreground",
    "descriptionForeground",
    "editorLineNumber.foreground",
    "statusBar.foreground",
    "tab.inactiveForeground",
    "titleBar.inactiveForeground",
  ],
  "--accent": [
    "activityBarBadge.background",
    "badge.background",
    "button.background",
    "editorCursor.foreground",
    "editorLineNumber.activeForeground",
    "focusBorder",
    "progressBar.background",
    "statusBarItem.remoteBackground",
    "tab.activeBorderTop",
    "textLink.activeForeground",
    "textLink.foreground",
  ],
  "--ui-on-accent": [
    "button.foreground",
    "activityBarBadge.foreground",
    "badge.foreground",
    "statusBarItem.remoteForeground",
  ],
  "--red": ["editorError.foreground", "errorForeground"],
  "--amber": ["editorWarning.foreground"],
  "--green": ["editorInfo.foreground", "gitDecoration.addedResourceForeground"],
};

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i;

function channel(value: string): string {
  return Math.max(0, Math.min(255, Math.round(Number(value))))
    .toString(16)
    .padStart(2, "0");
}

/**
 * Coerce a CSS colour to the `#rrggbb[aa]` form VS Code accepts.
 *
 * Returns null for anything else. That matters: a token that resolves to
 * `color-mix(...)` or an empty string would otherwise be written into the
 * workbench's settings, where an unparseable value is not ignored per-key —
 * it makes VS Code discard the customisation and log an error.
 */
export function toVsCodeColor(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (HEX.test(value)) return value.toLowerCase();

  const rgb = RGB.exec(value);
  if (!rgb) return null;
  const [, r, g, b, a] = rgb;
  const base = `#${channel(r!)}${channel(g!)}${channel(b!)}`;
  if (a === undefined) return base;
  const alpha = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
  if (!Number.isFinite(alpha) || alpha >= 1) return base;
  return `${base}${channel(String(Math.max(0, alpha) * 255))}`;
}

/** Reads one SomniQ token off an element's computed style. */
export type TokenReader = (token: string) => string;

/** Keep hover feedback in the selected hue instead of the base theme's blue. */
function accentHover(accent: string, text: string): string {
  const expand = (hex: string) => {
    const value = hex.slice(1);
    return value.length <= 4 ? value.split("").map((digit) => digit + digit).join("") : value;
  };
  const base = expand(accent);
  const foreground = expand(text);
  const rgb = [0, 2, 4].map((offset) =>
    channel(String(parseInt(base.slice(offset, offset + 2), 16) * .9
      + parseInt(foreground.slice(offset, offset + 2), 16) * .1)));
  return `#${rgb.join("")}${base.slice(6)}`;
}

/**
 * Build the `workbench.colorCustomizations` payload.
 *
 * A token that cannot be resolved to a usable colour is skipped rather than
 * guessed at, so a partial palette degrades to the base theme for those
 * surfaces instead of producing an unreadable mix.
 */
export function somniqWorkbenchColors(read: TokenReader): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [token, targets] of Object.entries(TOKEN_TARGETS)) {
    const color = toVsCodeColor(read(token) ?? "");
    if (!color) continue;
    for (const target of targets) colors[target] = color;
  }
  if (colors["button.background"] && colors.foreground) {
    colors["button.hoverBackground"] = accentHover(colors["button.background"], colors.foreground);
  }
  return colors;
}

/** Reads the tokens off `:root`, where both themes declare them. */
export function currentSomniqColors(): Record<string, string> {
  if (typeof window === "undefined" || typeof document === "undefined") return {};
  const style = window.getComputedStyle(document.documentElement);
  return somniqWorkbenchColors((token) => style.getPropertyValue(token));
}
