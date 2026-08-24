/**
 * Bound the retained cursors so a long-lived PWA that browses many desktop
 * conversations cannot accumulate them without limit. The oldest cursor is
 * dropped first; losing one only costs that conversation a single full
 * reconcile the next time it is opened.
 */
export const MAX_RETAINED_CHAT_EVENT_CURSORS = 32;

/**
 * Remembers how far the phone has consumed each desktop conversation's durable
 * event log.
 *
 * The desktop event log is append-only and sequence-addressed, so a client that
 * kept its cursor can resume exactly where a dropped transport left off instead
 * of replaying the whole turn. The cursor is tied to the *rendered transcript*,
 * not to the transport: rebuilding the connection must keep it, while reloading
 * the transcript from the desktop must drop it so the next batch re-reconciles
 * against freshly rendered messages.
 */
export class ChatEventCursorStore {
  private readonly cursors = new Map<string, number>();

  /**
   * Records a consumed sequence. Cursors only move forward: a late batch from
   * a transport that has already been replaced must never rewind a newer
   * cursor and cause the desktop to replay events the phone already rendered.
   */
  remember(projectId: string, sessionId: string, nextSeq: number): void {
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) {
      return;
    }
    const key = cursorKey(projectId, sessionId);
    const previous = this.cursors.get(key);
    if (previous !== undefined && previous >= nextSeq) {
      // Re-insert so an actively synced conversation stays newest in eviction
      // order even while the desktop has nothing new to report.
      this.cursors.delete(key);
      this.cursors.set(key, previous);
      return;
    }
    this.cursors.delete(key);
    this.cursors.set(key, nextSeq);
    while (this.cursors.size > MAX_RETAINED_CHAT_EVENT_CURSORS) {
      const oldest = this.cursors.keys().next();
      if (oldest.done) break;
      this.cursors.delete(oldest.value);
    }
  }

  /** The sequence to resume after, or null to request a fresh reconcile. */
  resume(projectId: string, sessionId: string): number | null {
    return this.cursors.get(cursorKey(projectId, sessionId)) ?? null;
  }

  /** Drops one conversation's cursor, e.g. after reloading its transcript. */
  forget(projectId: string, sessionId: string): void {
    this.cursors.delete(cursorKey(projectId, sessionId));
  }

  /** Drops every cursor, e.g. when the paired desktop device changes. */
  clear(): void {
    this.cursors.clear();
  }

  get size(): number {
    return this.cursors.size;
  }
}

function cursorKey(projectId: string, sessionId: string): string {
  // Project and session IDs are opaque strings, so length-prefix the project
  // instead of trusting a separator character. Two different (project,
  // session) pairs then provably cannot collide on a single key.
  return `${projectId.length}:${projectId}:${sessionId}`;
}
