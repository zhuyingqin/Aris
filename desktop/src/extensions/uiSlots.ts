/**
 * Reduced declarative list-slot adapter, adapted from DSH SlotCore.register /
 * entriesOfSlot (fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159), MIT, DeepSeek.
 * Retains host declaration, duplicate rejection, stable order and idempotent
 * disposal. SomniQ accepts data descriptors only, with no Cordis/JS host.
 * See third_party/deepseek-harness/NOTICE.md.
 */
export class UiListSlot<T> {
  private entries: { id: string; order: number; value: T }[] = [];
  constructor(readonly name: string) {}

  register(slot: string, id: string, order: number, value: T): () => void {
    if (slot !== this.name) throw new Error(`UI slot ${slot} is not declared`);
    if (this.entries.some((entry) => entry.id === id)) throw new Error(`UI slot ${slot} already contains ${id}`);
    const entry = { id, order, value };
    this.entries = [...this.entries, entry].sort((a, b) => a.order - b.order);
    return () => { this.entries = this.entries.filter((current) => current !== entry); };
  }

  values(): T[] { return this.entries.map((entry) => entry.value); }
}
