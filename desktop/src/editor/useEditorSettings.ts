import { useSyncExternalStore } from "react";
import { getEditorSettings, subscribeEditorSettings, type EditorSettings } from "./editorSettings";

/** React view of the module-level editor settings store. Live CodeMirror views
 * reconfigure themselves (see `createSharedEditorView`); this is only for the
 * chrome that renders and edits the values. */
export function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(subscribeEditorSettings, getEditorSettings, getEditorSettings);
}
