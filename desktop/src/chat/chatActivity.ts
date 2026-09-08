/**
 * Renderer-local activity is a small fast-path for the window close guard.
 * The backend broadcasts the authoritative process-wide total, but a user can
 * press Close in the few milliseconds between submitting a turn and the IPC
 * handler registering it. This registry covers that gap for the main window.
 */
const activeStreams = new Map<symbol, number>();

export function setClientChatStreamActivity(owner: symbol, runningCount: number) {
  const count = Math.max(0, Math.trunc(runningCount));
  if (count > 0) activeStreams.set(owner, count);
  else activeStreams.delete(owner);
}

export function clientRunningConversationCount(): number {
  let total = 0;
  activeStreams.forEach((count) => {
    total += count;
  });
  return total;
}
