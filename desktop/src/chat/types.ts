import type { ChatAttachment, ChatTurn } from "../types";

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  model?: string | null;
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
  draft: string;
  draftAttachments: ChatAttachment[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
