import { invoke } from "./transport";

export interface PluginPreview {
  name: string;
  version: string;
  description: string;
  source: string;
  digest: string;
  canEnable: boolean;
  diagnostics: { code: string; message: string; severity: string }[];
  capabilities: {
    skills: string[];
    skillRoots: string[];
    mcpServers: { name: string; command: string; args: string[] }[];
    uiPanels: UiPanel[];
  };
}

export interface InstalledPlugin extends PluginPreview {
  enabled: boolean;
  status: "enabled" | "disabled" | "blocked";
}

export const pluginsList = (projectPath: string) =>
  invoke<InstalledPlugin[]>("plugins_list", { projectPath });
export const pluginsPreview = (projectPath: string, source: string) =>
  invoke<PluginPreview>("plugins_preview", { projectPath, source });
export const PLUGINS_CHANGED_EVENT = "somniq:plugins-changed";
async function changed<T>(projectPath: string, result: Promise<T>): Promise<T> {
  const value = await result;
  window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT, { detail: projectPath }));
  return value;
}
export const pluginsInstall = (projectPath: string, source: string, expectedDigest: string) =>
  changed(projectPath, invoke<InstalledPlugin>("plugins_install", { projectPath, source, expectedDigest }));
export const pluginsSetEnabled = (projectPath: string, name: string, enabled: boolean) =>
  changed(projectPath, invoke<InstalledPlugin>("plugins_set_enabled", { projectPath, name, enabled }));
export const pluginsRemove = (projectPath: string, name: string) =>
  changed(projectPath, invoke<void>("plugins_remove", { projectPath, name }));

export type UiText = string | { en: string; cn: string };
export type UiWidget =
  | { type: "todo-list" | "notes" | "agent-plan"; id: string; title: UiText }
  | { type: "text"; id: string; text: UiText };
export interface UiPanel {
  id: string;
  slot: "chat.sidebar";
  title: UiText;
  order: number;
  widgets: UiWidget[];
}
export interface ActiveUiPanel extends UiPanel {
  pluginName: string;
  packageDigest: string;
}
export interface UiTodo { id: string; text: string; completed: boolean }
export interface UiPanelState {
  revision: number;
  todoLists: Record<string, UiTodo[]>;
  notes: Record<string, string>;
}
export type UiAction =
  | { type: "todoAdd"; widgetId: string; text: string }
  | { type: "todoSetCompleted"; widgetId: string; itemId: string; completed: boolean }
  | { type: "todoRemove"; widgetId: string; itemId: string }
  | { type: "notesSet"; widgetId: string; text: string };

export const pluginsUiList = (projectPath: string) =>
  invoke<ActiveUiPanel[]>("plugins_ui_list", { projectPath });
export const pluginsUiStateGet = (projectPath: string, name: string, panelId: string, sessionId: string) =>
  invoke<UiPanelState>("plugins_ui_state_get", { projectPath, name, panelId, sessionId });
export const pluginsUiStateUpdate = (projectPath: string, name: string, panelId: string, sessionId: string, expectedRevision: number, action: UiAction) =>
  invoke<UiPanelState>("plugins_ui_state_update", { projectPath, name, panelId, sessionId, expectedRevision, action });
