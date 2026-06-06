import type { ChatAttachment, ChatTurn } from "../types";

export interface ChatSession {
  id: string;
  title: string;
  turns: ChatTurn[];
  draft: string;
  draftAttachments: ChatAttachment[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
