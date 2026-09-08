/** Browser previews use the host OS; native macOS windows have system controls. */
export function isMacOS(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

export function primaryModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacOS() ? event.metaKey : event.ctrlKey;
}

export function primaryShortcut(keys: string): string {
  return `${isMacOS() ? "⌘" : "Ctrl+"}${keys}`;
}
