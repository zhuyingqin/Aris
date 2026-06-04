import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** True only inside the Tauri webview; false in a plain browser (vite preview). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type {
  ConfigPatch,
  ConfigView,
  RunEvent,
  SessionSummary,
  SessionTranscript,
  SkillMeta,
  TeamSnapshot,
  WorkflowApproval,
  WorkflowControlAction,
  WorkflowOutput,
} from "../types";

// ── Workflow commands ─────────────────────────────────────────────────────────

export const workflowPlan = (script: string) =>
  invoke<WorkflowOutput>("workflow_plan", { script });

export const workflowList = () => invoke<WorkflowOutput>("workflow_list");

export const workflowInspect = (id: string) =>
  invoke<WorkflowOutput>("workflow_inspect", { id });

export interface StartReq {
  script: string;
  approval: WorkflowApproval;
  name?: string;
  saveAs?: string;
  maxConcurrency?: number;
  maxAgents?: number;
}

export const workflowStart = (req: StartReq) =>
  invoke<WorkflowOutput>("workflow_start", { req });

export const workflowControl = (id: string, action: WorkflowControlAction) =>
  invoke<WorkflowOutput>("workflow_control", { id, action });

export const workflowSave = (name: string, script: string) =>
  invoke<WorkflowOutput>("workflow_save", { name, script });

export const workflowDiscover = () =>
  invoke<WorkflowOutput>("workflow_discover");

// ── Team / agent commands ─────────────────────────────────────────────────────

export const teamList = (
  team: string | null,
  messages: boolean,
  events: boolean,
) => invoke<TeamSnapshot>("team_list", { team, messages, events });

export const agentSupervisor = (action: string, agent?: string) =>
  invoke<unknown>("agent_supervisor", { action, agent: agent ?? null });

export const stateDir = () => invoke<string>("state_dir");

// ── Settings / Skills / Sessions (P1) ─────────────────────────────────────────

export const configGet = () => invoke<ConfigView>("config_get");
export const configSet = (patch: ConfigPatch) =>
  invoke<ConfigView>("config_set", { patch });

export const skillsList = () => invoke<SkillMeta[]>("skills_list");
export const skillView = (name: string) =>
  invoke<string>("skill_view", { name });

export const sessionsList = () => invoke<SessionSummary[]>("sessions_list");
export const sessionGet = (id: string) =>
  invoke<SessionTranscript>("session_get", { id });

// ── Live events ───────────────────────────────────────────────────────────────

export const onRunEvent = (
  handler: (event: RunEvent) => void,
): Promise<UnlistenFn> =>
  listen<RunEvent>("run-event", (e) => handler(e.payload));
