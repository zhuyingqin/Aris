import { hasNativeBackend, invoke, listen } from "./transport";

export interface PluginPreview {
  name: string;
  version: string;
  description: string;
  source: string;
  digest: string;
  canEnable: boolean;
  /** `file`, `path` and `hint` locate the problem and say how to fix it (English, for authors and agents). */
  diagnostics: { code: string; message: string; severity: string; file?: string; path?: string; hint?: string }[];
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
  /** Versions this one replaced, newest first; the last is the original. Absent from older backends. */
  history?: PluginVersion[];
  /** The digest the package was first installed with, when known. */
  originalDigest?: string | null;
}
/** A version an upgrade replaced; its snapshot stays on this computer. */
export interface PluginVersion { version: string; digest: string; source: string; replacedAt: number }
/** One file a draft changes against the installed version. Text is absent for binary or large files. */
export interface PackageFileChange {
  path: string; change: "added" | "removed" | "changed"; binary: boolean;
  before?: string; after?: string; beforeBytes: number; afterBytes: number;
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
/** The backend's announcement that a project's plugins changed outside the
 *  view's own calls (an agent's PluginManager call, an approval card). */
const BACKEND_PLUGINS_CHANGED_EVENT = "plugins-changed";

/** Whether two spellings name the same project: the backend reports
 *  canonical paths (verbatim `\\?\` prefix, either slash), the UI keeps the
 *  registered one. */
export function samePluginProject(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return pluginPathKey(a) === pluginPathKey(b);
}

/** One spelling of a local path for comparisons: no verbatim prefix, forward
 *  slashes, no trailing slash, and lower case for Windows drive paths. */
export function pluginPathKey(value: string): string {
  const path = value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows paths compare case-insensitively.
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

/** An agent's `PluginPanel` write changed what one panel shows. */
export const PLUGIN_PANEL_CHANGED_EVENT = "somniq:plugin-panel-changed";
const BACKEND_PLUGIN_PANEL_CHANGED_EVENT = "plugin-panel-changed";
export interface PluginPanelChange {
  projectPath: string; pluginName: string; panelId: string;
  /** The page frame that made the change, which already shows it; absent for the agent's writes. */
  origin?: string;
}

let backendBridge: Promise<unknown> | null = null;
/** Re-dispatch the backend's plugin changes as the window event every plugin
 *  view already listens to. Idempotent; a failed subscription retries on the
 *  next call. */
export function bridgeBackendPluginChanges(): void {
  if (backendBridge || !hasNativeBackend()) return;
  backendBridge = Promise.all([
    listen<{ projectPath: string }>(BACKEND_PLUGINS_CHANGED_EVENT, (event) => {
      window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT, { detail: event.payload.projectPath }));
    }),
    listen<PluginPanelChange>(BACKEND_PLUGIN_PANEL_CHANGED_EVENT, (event) => {
      window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_CHANGED_EVENT, { detail: event.payload }));
    }),
  ]).catch(() => {
    backendBridge = null;
  });
}

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
/** Put back an earlier version; `approve` keeps a running package running on it. */
export const pluginsRollback = (projectPath: string, name: string, digest: string, expectedCurrentDigest: string, approve: boolean) =>
  changed(projectPath, invoke<InstalledPlugin>("plugins_rollback", { projectPath, name, digest, expectedCurrentDigest, approve }));
/** Every file an upgrade card's draft changes; refused if the draft changed since the card. */
export const pluginsDraftChanges = (projectPath: string, source: string, digest: string) =>
  invoke<PackageFileChange[]>("plugins_draft_changes", { projectPath, source, digest });
export const pluginsSetEnabled = (projectPath: string, name: string, enabled: boolean) =>
  changed(projectPath, invoke<InstalledPlugin>("plugins_set_enabled", { projectPath, name, enabled }));
export const pluginsRemove = (projectPath: string, name: string) =>
  changed(projectPath, invoke<void>("plugins_remove", { projectPath, name }));

export type UiText = string | { en: string; cn: string };
/** What a click does. The host does it on the user's click; no package code runs. */
export type UiClick =
  | { type: "prompt"; text: string; send?: boolean }
  | { type: "open-file"; path: string };
export interface UiField {
  key: string;
  label: UiText;
  input: "text" | "textarea" | "number" | "select" | "checkbox";
  options?: string[];
}
export type UiWidget =
  | { type: "todo-list" | "notes" | "agent-plan"; id: string; title: UiText }
  | { type: "metrics" | "list" | "markdown" | "progress"; id: string; title: UiText }
  /** Free-form data of a panel that draws itself; the host never renders it. */
  | { type: "json"; id: string; title: UiText }
  | { type: "text"; id: string; text: UiText }
  | { type: "table"; id: string; title: UiText; columns: { key: string; title: UiText }[] }
  | { type: "chart"; id: string; title: UiText; chart: "bar" | "line" }
  | { type: "form"; id: string; title: UiText; fields: UiField[]; submit: { label: UiText; action: UiClick } }
  | { type: "button"; id: string; label: UiText; action: UiClick };
export interface UiPanel {
  id: string;
  /** `chat.brief`: a small glance in the Chat's project summary. */
  slot: "chat.sidebar" | "nav.page" | "chat.brief";
  title: UiText;
  /** A host icon name; only names the backend's contract lists get here. */
  icon?: string;
  order: number;
  /** `project`: one copy for every conversation of the project. Absent on
   *  panels listed by an older backend, which are all `session`. */
  scope?: "session" | "project";
  /** The package's own HTML draws this panel, in a sandboxed frame. */
  page?: string;
  /** Another panel of the same package whose data this panel's page reads
   *  and writes; this panel then keeps none of its own. */
  dataPanel?: string;
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
  /** Values an agent wrote with `PluginPanel`, by widget id. The backend
   *  checked each against its widget's shape. */
  data?: Record<string, unknown>;
}
export type UiTableCell = string | number | boolean | null;
export interface UiMetric { label: string; value: string | number; hint?: string; tone?: "good" | "warn" | "bad" }
export interface UiListItem { title: string; detail?: string; tag?: string; path?: string; url?: string }
export interface UiProgress { value: number; label?: string }
export interface UiChartData { labels: string[]; series: { name: string; values: (number | null)[] }[] }
export type UiAction =
  | { type: "todoAdd"; widgetId: string; text: string }
  | { type: "todoSetCompleted"; widgetId: string; itemId: string; completed: boolean }
  | { type: "todoRemove"; widgetId: string; itemId: string }
  | { type: "notesSet"; widgetId: string; text: string }
  /** Replace everything one widget holds; the backend checks the widget's shape. */
  | { type: "widgetSet"; widgetId: string; value: unknown };

export const pluginsUiList = (projectPath: string) =>
  invoke<ActiveUiPanel[]>("plugins_ui_list", { projectPath });
/** A page panel's HTML, from the reviewed snapshot. Only ever put in a sandboxed frame. */
export interface UiPageFile {
  html: string;
  /** The page's package-relative path; its relative links resolve from here. */
  path: string;
  /** Every file the page can use, by package-relative path, as base64. */
  assets: Record<string, { mime: string; data: string }>;
  packageDigest: string;
}
export const pluginsUiPage = (projectPath: string, name: string, panelId: string) =>
  invoke<UiPageFile>("plugins_ui_page", { projectPath, name, panelId });
/** A draft panel's page with its declarations, to try on an upgrade card. */
export interface DraftPage { page: UiPageFile; panel: UiPanel; store?: UiPanel }
export const pluginsDraftPage = (projectPath: string, source: string, digest: string, panelId: string) =>
  invoke<DraftPage>("plugins_draft_page", { projectPath, source, digest, panelId });
export const pluginsUiStateGet = (projectPath: string, name: string, panelId: string, sessionId: string) =>
  invoke<UiPanelState>("plugins_ui_state_get", { projectPath, name, panelId, sessionId });
export const pluginsUiStateUpdate = (projectPath: string, name: string, panelId: string, sessionId: string, expectedRevision: number, action: UiAction) =>
  invoke<UiPanelState>("plugins_ui_state_update", { projectPath, name, panelId, sessionId, expectedRevision, action });

/** What a `PluginManager` call asks the user to allow. Built by the backend
 *  from the installed or previewed package, never from model input. */
export interface PluginApprovalCard {
  kind: "enable" | "upgrade" | "remove";
  name: string;
  version: string;
  description: string;
  digest: string;
  source: string;
  capabilities: {
    skills: string[];
    /** `page`: the panel runs the package's own HTML and JavaScript, sandboxed. */
    uiPanels: { id: string; slot: string; title: UiText; widgets: number; page?: boolean }[];
    /** Environment variable names only; values never leave the backend. */
    mcpServers: { name: string; command: string; args: string[]; envKeys: string[]; requestTimeoutSecs?: number | null }[];
  };
  /** Upgrade only: the running version and what changes. */
  currentVersion?: string | null;
  diff?: CapabilityDiff | null;
  /** Upgrade only: no command line or environment key changes. */
  executionUnchanged?: boolean | null;
  /** Upgrade only: every file that changes (contents via `pluginsDraftChanges`). */
  files?: { path: string; change: "added" | "removed" | "changed"; binary: boolean; beforeBytes: number; afterBytes: number }[];
  /** Upgrade only: the new version's panels that draw their own page, to try first. */
  pagePanels?: { id: string; slot: string; title: UiText }[];
  /** Approvals belong to this computer; other surfaces show no buttons. */
  approveOn: "desktop";
}

/** Answer an approval card. Only the main window is accepted, and only for
 *  the digest the card showed. */
export const chatPluginApprovalRespond = (toolUseId: string, digest: string, approve: boolean) =>
  invoke<void>("chat_plugin_approval_respond", { toolUseId, digest, approve });
