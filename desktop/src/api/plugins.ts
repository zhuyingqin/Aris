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
    mcpServers: { name: string; command: string; args: string[]; env?: Record<string, string> }[];
    uiPanels: UiPanel[];
  };
}

/** What a package is doing, not just how it is configured (runtime::plugins::lifecycle). */
export type PluginState =
  | "installed" | "approval-required" | "blocked" | "enabled" | "running" | "failed" | "needs-restart";

export interface PluginMcpStatus {
  /** As the package declares it. */
  name: string;
  /** As Chat and the MCP settings list it. */
  runtimeName: string;
  /** From the last real discovery of exactly this command line. */
  health: "unchecked" | "connected" | "failed";
  toolCount: number;
  message: string | null;
  checkedAtMs: number | null;
}

export interface PluginLifecycle {
  state: PluginState;
  /** In-flight runs of this project that froze this package, any version. */
  activeRuns: number;
  /** In-flight runs whose frozen copy differs from what the next run gets. */
  staleRuns: number;
  mcpServers: PluginMcpStatus[];
}

export interface InstalledPlugin extends PluginPreview {
  /** Approved and enabled: the next run gets it. Configuration only. */
  enabled: boolean;
  status: "enabled" | "disabled" | "blocked";
  lifecycle: PluginLifecycle;
}

export interface ListChange { added: string[]; removed: string[] }
export interface McpServerDiff {
  name: string;
  change: "added" | "removed" | "changed" | "unchanged";
  before: string | null;
  after: string | null;
  envAdded: string[];
  envRemoved: string[];
  envChanged: string[];
}
export interface CapabilityDiff {
  skills: ListChange;
  uiPanels: ListChange;
  mcpServers: McpServerDiff[];
  commands: ListChange;
  envKeys: ListChange;
  changed: boolean;
}
export interface PluginUpgradePlan {
  currentVersion: string;
  currentDigest: string;
  /** The installed version runs here, so the new one must be approved to keep running. */
  currentEnabled: boolean;
  change: "upgrade" | "downgrade" | "same-version" | "identical";
  diff: CapabilityDiff;
}
/** A preview, plus the upgrade it would be when the name is already installed. */
export interface PluginImportPreview extends PluginPreview {
  upgrade: PluginUpgradePlan | null;
}

export const pluginsList = (projectPath: string) =>
  invoke<InstalledPlugin[]>("plugins_list", { projectPath });
export const pluginsPreview = (projectPath: string, source: string) =>
  invoke<PluginImportPreview>("plugins_preview", { projectPath, source });
/** Connect to the package's approved MCP servers now and report their health. */
export const pluginsCheckMcp = (projectPath: string, name: string) =>
  invoke<InstalledPlugin>("plugins_check_mcp", { projectPath, name });
export const PLUGINS_CHANGED_EVENT = "somniq:plugins-changed";
async function changed<T>(projectPath: string, result: Promise<T>): Promise<T> {
  const value = await result;
  window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT, { detail: projectPath }));
  return value;
}
export const pluginsInstall = (projectPath: string, source: string, expectedDigest: string) =>
  changed(projectPath, invoke<InstalledPlugin>("plugins_install", { projectPath, source, expectedDigest }));
/** Replace the installed version, approving the new digest when `approve` is set. */
export const pluginsUpgrade = (projectPath: string, source: string, expectedDigest: string, expectedCurrentDigest: string, approve: boolean) =>
  changed(projectPath, invoke<InstalledPlugin>("plugins_upgrade", { projectPath, source, expectedDigest, expectedCurrentDigest, approve }));
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
