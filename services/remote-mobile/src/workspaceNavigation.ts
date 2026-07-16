import type { ControlResponse } from "./control";

export interface RemoteWorkspaceProject {
  projectId: string;
  title: string;
  phase: string;
  updatedAtUnixMs: number;
  activeRunId: string | null;
  isActive: boolean;
}

/**
 * Optional commands advertised by a current desktop build. The parser keeps
 * track of an omitted list separately so a newly deployed phone can make one
 * compatibility probe during a rolling desktop update.
 */
export type RemoteWorkspaceCapability =
  | "set_active_project"
  | "create_chat_session"
  | "get_chat_model_options"
  | "set_chat_session_model"
  | "stop_chat_message"
  | "rich_chat_progress"
  | "chat_event_sync";

export interface RemoteWorkspaceOverview {
  projects: RemoteWorkspaceProject[];
  capabilities: RemoteWorkspaceCapability[];
  /** Whether this desktop explicitly supplied its optional command list. */
  capabilitiesAdvertised: boolean;
}

const KNOWN_CAPABILITIES = new Set<RemoteWorkspaceCapability>([
  "set_active_project",
  "create_chat_session",
  "get_chat_model_options",
  "set_chat_session_model",
  "stop_chat_message",
  "rich_chat_progress",
  "chat_event_sync",
]);

/**
 * Validates the compact project projection before it is rendered in the
 * mobile workspace drawer. The control channel itself is encrypted, but the
 * browser should still reject malformed device responses rather than mixing
 * them into the selected conversation state.
 */
export function workspaceOverviewFromResponse(response: ControlResponse): RemoteWorkspaceOverview | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const resultValue = response.outcome.result;
  if (resultValue.type !== "workspace_overview" || !Array.isArray(resultValue.projects)) {
    return null;
  }

  const capabilityState = parseCapabilities(resultValue.capabilities);
  if (!capabilityState) {
    return null;
  }

  const projects: RemoteWorkspaceProject[] = [];
  const seenIds = new Set<string>();
  let activeProjectCount = 0;
  for (const entry of resultValue.projects) {
    if (!isRecord(entry)) {
      return null;
    }
    const activeRunId = entry.active_run_id === undefined ? null : entry.active_run_id;
    if (
      typeof entry.project_id !== "string" ||
      entry.project_id.length === 0 ||
      typeof entry.title !== "string" ||
      typeof entry.phase !== "string" ||
      typeof entry.updated_at_unix_ms !== "number" ||
      !Number.isSafeInteger(entry.updated_at_unix_ms) ||
      (activeRunId !== null && typeof activeRunId !== "string") ||
      (entry.is_active !== undefined && typeof entry.is_active !== "boolean") ||
      seenIds.has(entry.project_id)
    ) {
      return null;
    }
    seenIds.add(entry.project_id);
    const isActive = entry.is_active === true;
    if (isActive) activeProjectCount += 1;
    projects.push({
      projectId: entry.project_id,
      title: entry.title.trim() || "SomniQ 项目",
      phase: entry.phase.trim() || "active",
      updatedAtUnixMs: entry.updated_at_unix_ms,
      activeRunId,
      isActive,
    });
  }
  if (activeProjectCount > 1) {
    return null;
  }
  return { projects, ...capabilityState };
}

/** Maintains the original projects-only parser for callers that do not need capability negotiation. */
export function workspaceProjectsFromResponse(response: ControlResponse): RemoteWorkspaceProject[] | null {
  return workspaceOverviewFromResponse(response)?.projects ?? null;
}

function parseCapabilities(
  value: unknown,
): Pick<RemoteWorkspaceOverview, "capabilities" | "capabilitiesAdvertised"> | null {
  if (value === undefined) {
    return { capabilities: [], capabilitiesAdvertised: false };
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const capabilities: RemoteWorkspaceCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const capability = entry as RemoteWorkspaceCapability;
    if (KNOWN_CAPABILITIES.has(capability) && !capabilities.includes(capability)) {
      capabilities.push(capability);
    }
  }
  return { capabilities, capabilitiesAdvertised: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
