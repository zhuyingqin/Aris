// Local layout choices shared by the PDF reader and the literature library.
// One stored record (the key predates the move to pdf/) so a choice made in
// either place survives; each side reads only its own fields.
const LAYOUT_STORAGE_KEY = "somniq-literature-layout-v1";

/** What the reader itself remembers. */
export interface ReaderLayoutPrefs {
  pdfToolbarCollapsed?: boolean;
}

export function readLayoutPrefs<T extends object = ReaderLayoutPrefs>(): T {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}");
    return (parsed && typeof parsed === "object" ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

export function writeLayoutPrefs<T extends object = ReaderLayoutPrefs>(patch: T) {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...readLayoutPrefs(), ...patch }));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); layout
    // then simply resets next time.
  }
}

/** Keyboard shortcuts must never fire while the user is typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
