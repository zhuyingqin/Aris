import type { ChangeSet, Text } from "@codemirror/state";
import { scanLatexStructure, updateLatexStructure, type LatexStructureIndex } from "./latexStructure";

/**
 * A structural index brought up to date only when it is read.
 *
 * Mapping the index through an edit re-creates every command, heading and
 * environment of the document — about 14 ms per keystroke on a 500 KB thesis,
 * which is the whole frame budget. Its readers (the linter, after a typing
 * pause; the Visual editor, when the caret enters rendered syntax) need it far
 * less often than edits arrive, so edits are composed into one pending change
 * set — cheap — and the index is mapped through all of them, or rescanned,
 * once at the first read.
 */
export class PendingLatexStructure {
  private current: LatexStructureIndex | null;

  private constructor(
    private readonly base: LatexStructureIndex | null,
    private readonly pending: ChangeSet | null,
    private readonly doc: Text,
  ) {
    this.current = pending ? null : base;
  }

  /** Scanned at the first read. */
  static of(doc: Text): PendingLatexStructure {
    return new PendingLatexStructure(null, null, doc);
  }

  static resolved(structure: LatexStructureIndex, doc: Text): PendingLatexStructure {
    return new PendingLatexStructure(structure, null, doc);
  }

  /** The index after an edit, still unresolved. */
  next(changes: ChangeSet, doc: Text): PendingLatexStructure {
    if (this.current) return new PendingLatexStructure(this.current, changes, doc);
    if (!this.base || !this.pending) return PendingLatexStructure.of(doc);
    return new PendingLatexStructure(this.base, this.pending.compose(changes), doc);
  }

  /** Whether reading would cost nothing. */
  get isResolved(): boolean {
    return this.current !== null;
  }

  get(): LatexStructureIndex {
    if (!this.current) {
      const source = this.doc.toString();
      this.current = this.base && this.pending
        ? updateLatexStructure(this.base, source, this.pending) ?? scanLatexStructure(source)
        : scanLatexStructure(source);
    }
    return this.current;
  }
}
