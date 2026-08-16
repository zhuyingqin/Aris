import type { ChatAttachment, ChatTurn } from "../types";

export interface RemoteAgentBinding {
  nodeId: string;
  nodeName: string;
  projectId: string;
  projectName: string;
  sessionId: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  /** Where `title` came from. A user rename is never overwritten; a generated
   * title is refreshed once if the conversation moves on; anything else (legacy
   * sessions, the local first-message fallback) is still waiting for one. */
  titleSource?: "user" | "auto";
  /** User-question count the generated title was derived from. */
  titleQuestionCount?: number;
  /** Stable owner key for sessions created by a structured-surface handoff. */
  workflowContextKey?: string;
  /** Rust ledger run that owns this append-only workflow conversation. */
  workflowRunId?: string;
  /** Prevent generic Chat lifecycle controls from deleting a live workflow runtime. */
  ownerKind?: "review_workflow";
  /** Last generated snapshot, used to refresh context without losing user draft text. */
  workflowContextSnapshot?: string;
  /** Turns controlled by the workflow projection rather than by Chat execution. */
  workflowProjectionTurnIds?: string[];
  model?: string | null;
  /** When present, turns execute in this paired computer's Agent session. */
  remoteAgent?: RemoteAgentBinding | null;
  turns: ChatTurn[];
  turnsLoaded?: boolean;
  turnsPartial?: boolean;
  turnCount?: number;
  /** Absolute index of the first loaded turn when the transcript is partial. */
  loadedTurnStartIndex?: number;
  /** Number of user questions preceding the currently loaded transcript. */
  questionCountBeforeLoadedTurns?: number;
  partialBaseTurnIds?: string[];
  /** Last backend-confirmed session-history token estimate. This remains valid
   * after the visible transcript has been compacted or the app restarts. */
  contextTokens?: number;
  /** User turn whose completed backend context produced `contextTokens`. */
  contextTokensUserTurnId?: string;
  draft: string;
  draftAttachments: ChatAttachment[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
