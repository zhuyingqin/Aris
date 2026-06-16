import type { ChatAttachment, ChatTurn } from "../types";

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  model?: string | null;
  turns: ChatTurn[];
  draft: string;
  draftAttachments: ChatAttachment[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
