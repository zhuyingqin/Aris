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
