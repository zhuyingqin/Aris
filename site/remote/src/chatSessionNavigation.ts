/**
 * The gateway usually returns sessions newest-first, but the mobile landing
 * behavior must remain correct if that ordering changes.
 */
export interface ChatSessionCandidate {
  sessionId: string;
  updatedAtUnixMs: number;
}

export function newestChatSessionId(sessions: readonly ChatSessionCandidate[]): string | null {
  let newest: ChatSessionCandidate | null = null;
  for (const session of sessions) {
    if (newest === null || session.updatedAtUnixMs > newest.updatedAtUnixMs) {
      newest = session;
    }
  }
  return newest?.sessionId ?? null;
}
