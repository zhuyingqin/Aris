/**
 * Track changes for the LaTeX editors.
 *
 * While recording, an edit does not simply change the text: what it inserts
 * is marked as an insertion, and what it removes is kept as a deletion — a
 * point in the text carrying the removed words, drawn struck through. The
 * text itself is always the "all accepted" version, so compiling shows the
 * revised document, as Overleaf does.
 *
 * The record is a diff against the text before tracking began, kept honest
 * by one rule per edit: the old text an edit removes (minus tracked
 * insertions, which simply go away) plus any deletions it touches, against
 * what it inserts — with the common ends cancelled. That one rule makes undo
 * put a deletion back by cancelling it, retyping a deleted word cancel it,
 * and deleting one's own insertion leave no trace.
 *
 * One view records (Typeset's Code view, which sees every edit of both
 * modes); others only display what they are given.
 */
import { Annotation, StateEffect, StateField, Transaction, type ChangeDesc, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, hoverTooltip, type DecorationSet, type Tooltip } from "@codemirror/view";
import { tr } from "../language";
import { useStore } from "../store";

export interface TrackedChange {
  id: string;
  kind: "insert" | "delete";
  /** An insertion spans from..to; a deletion is the point from === to. */
  from: number;
  to: number;
  /** The inserted text, or the deleted text. */
  text: string;
  author: string;
  createdAtMs: number;
}

/** A change as stored on disk, with surrounding text to find it again. */
export interface StoredTrackedChange extends TrackedChange {
  before: string;
  after: string;
}

/** Replaces the view's tracked changes; positions refer to the new text. */
export const setTrackedChanges = StateEffect.define<TrackedChange[]>();
/** Accepted or rejected: dropped from the record (after mapping). */
export const resolveTrackedChanges = StateEffect.define<string[]>();
/** Recording on or off in the recording view; null makes a view display-only. */
export const setTrackChangesRecording = StateEffect.define<{ enabled: boolean; author: string } | null>();
/** An edit that is itself an accept/reject, never recorded as a change. */
export const untrackedEdit = Annotation.define<boolean>();

/** Fired on the editor when a change's card asks to accept or reject it. */
export const TRACKED_CHANGE_EVENT = "typeset-tracked-change";
export type TrackedChangeEventDetail = { id: string; action: "accept" | "reject" };

let idCounter = 0;
const nextId = (now: number) => `t-${now.toString(36)}-${(idCounter += 1).toString(36)}`;

/** Sorted, with touching insertions of one author (and overlapping ones) merged, and deletions at one point joined. */
function normalized(changes: TrackedChange[]): TrackedChange[] {
  const sorted = [...changes].sort((left, right) =>
    left.from - right.from || (left.kind === right.kind ? left.createdAtMs - right.createdAtMs : left.kind === "delete" ? -1 : 1));
  const result: TrackedChange[] = [];
  for (const change of sorted) {
    const previous = result[result.length - 1];
    if (previous && previous.kind === "insert" && change.kind === "insert"
      && (change.from < previous.to || (change.from === previous.to && change.author === previous.author))) {
      // Both texts are slices of the same document, so the union is the
      // earlier one plus whatever of the later one runs past its end.
      const to = Math.max(previous.to, change.to);
      const text = change.to > previous.to ? previous.text + change.text.slice(previous.to - change.from) : previous.text;
      result[result.length - 1] = { ...previous, to, text };
      continue;
    }
    if (previous && previous.kind === "delete" && change.kind === "delete" && change.from === previous.from) {
      result[result.length - 1] = { ...previous, text: previous.text + change.text };
      continue;
    }
    result.push(change);
  }
  return result;
}

/** Changes carried through an edit that is not recorded. */
export function mapTrackedChanges(changes: TrackedChange[], edit: ChangeDesc, doc: Text): TrackedChange[] {
  if (changes.length === 0) return changes;
  const mapped: TrackedChange[] = [];
  for (const change of changes) {
    if (change.kind === "insert") {
      const from = edit.mapPos(change.from, 1);
      const to = edit.mapPos(change.to, -1);
      if (to > from) mapped.push({ ...change, from, to, text: doc.sliceString(from, to) });
    } else {
      const at = edit.mapPos(change.from, -1);
      mapped.push({ ...change, from: at, to: at });
    }
  }
  return normalized(mapped);
}

/** Changes after a recorded edit; see the module comment for the rule. */
export function recordTrackedEdit(
  changes: TrackedChange[],
  transaction: Pick<Transaction, "changes" | "startState" | "newDoc">,
  author: string,
  now = Date.now(),
): TrackedChange[] {
  const { changes: edit, newDoc } = transaction;
  const oldDoc = transaction.startState.doc;
  const ranges: { fromA: number; toA: number; fromB: number; inserted: string }[] = [];
  edit.iterChanges((fromA, toA, fromB, _toB, inserted) => ranges.push({ fromA, toA, fromB, inserted: inserted.toString() }));
  const insertions = changes.filter((change) => change.kind === "insert");
  const absorbed = ranges.map(() => [] as TrackedChange[]);
  const kept: TrackedChange[] = [];
  for (const change of changes) {
    if (change.kind === "delete") {
      // A deletion the edit touches, at either end, becomes part of it.
      const index = ranges.findIndex((range) => change.from >= range.fromA && change.from <= range.toA);
      if (index >= 0) {
        absorbed[index].push(change);
        continue;
      }
      const at = edit.mapPos(change.from, -1);
      kept.push({ ...change, from: at, to: at });
    } else {
      const from = edit.mapPos(change.from, 1);
      const to = edit.mapPos(change.to, -1);
      if (to > from) kept.push({ ...change, from, to, text: newDoc.sliceString(from, to) });
    }
  }
  ranges.forEach((range, index) => {
    // What this edit took away, in reading order: original text outside
    // tracked insertions, and the deletions it touched.
    const pieces: { at: number; ghost: boolean; text: string }[] = [];
    // Original text is cut at each deletion inside it, so a deletion's words
    // land between the right letters.
    const cuts = absorbed[index].map((ghost) => ghost.from);
    const pushText = (start: number, end: number) => {
      let from = start;
      for (const cut of [...cuts].sort((left, right) => left - right)) {
        if (cut <= from || cut >= end) continue;
        pieces.push({ at: from, ghost: false, text: oldDoc.sliceString(from, cut) });
        from = cut;
      }
      pieces.push({ at: from, ghost: false, text: oldDoc.sliceString(from, end) });
    };
    let cursor = range.fromA;
    const covering = insertions
      .filter((change) => change.to > range.fromA && change.from < range.toA)
      .sort((left, right) => left.from - right.from);
    for (const insertion of covering) {
      const start = Math.max(insertion.from, range.fromA);
      if (start > cursor) pushText(cursor, start);
      cursor = Math.max(cursor, Math.min(insertion.to, range.toA));
    }
    if (range.toA > cursor) pushText(cursor, range.toA);
    for (const ghost of absorbed[index]) pieces.push({ at: ghost.from, ghost: true, text: ghost.text });
    pieces.sort((left, right) => left.at - right.at || Number(right.ghost) - Number(left.ghost));
    let removed = pieces.map((piece) => piece.text).join("");
    let inserted = range.inserted;
    // Equal ends are no change: an undo that restores a deletion, retyping
    // a deleted word, or a replacement that only alters its middle.
    let prefix = 0;
    while (prefix < removed.length && prefix < inserted.length && removed[prefix] === inserted[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < removed.length - prefix
      && suffix < inserted.length - prefix
      && removed[removed.length - 1 - suffix] === inserted[inserted.length - 1 - suffix]
    ) suffix += 1;
    removed = removed.slice(prefix, removed.length - suffix);
    inserted = inserted.slice(prefix, inserted.length - suffix);
    const at = range.fromB + prefix;
    const deletionAuthor = absorbed[index][0]?.author ?? author;
    if (removed) kept.push({ id: absorbed[index][0]?.id ?? nextId(now), kind: "delete", from: at, to: at, text: removed, author: deletionAuthor, createdAtMs: now });
    if (inserted) kept.push({ id: nextId(now), kind: "insert", from: at, to: at + inserted.length, text: inserted, author, createdAtMs: now });
  });
  return normalized(kept);
}

/** The text with every change accepted is the text itself; rejecting all gives the original. */
export function rejectedText(text: string, changes: TrackedChange[]): string {
  let result = "";
  let cursor = 0;
  for (const change of normalized(changes)) {
    result += text.slice(cursor, change.from);
    if (change.kind === "delete") {
      result += change.text;
      cursor = change.from;
    } else {
      cursor = change.to;
    }
  }
  return result + text.slice(cursor);
}

const CONTEXT = 24;

export function storedTrackedChanges(changes: TrackedChange[], doc: string): StoredTrackedChange[] {
  return changes.map((change) => ({
    ...change,
    before: doc.slice(Math.max(0, change.from - CONTEXT), change.from),
    after: doc.slice(change.to, change.to + CONTEXT),
  }));
}

function nearestOccurrence(doc: string, needle: string, near: number): number {
  if (!needle) return -1;
  let best = -1;
  let found = doc.indexOf(needle);
  for (let count = 0; found >= 0 && count < 500; count += 1) {
    if (best < 0 || Math.abs(found - near) < Math.abs(best - near)) best = found;
    found = doc.indexOf(needle, found + 1);
  }
  return best;
}

/**
 * Stored changes placed on the text as it is now. One that no longer fits —
 * its inserted text, or the text around a deletion, edited away outside the
 * editor — is dropped rather than drawn in the wrong place.
 */
export function anchorTrackedChanges(stored: Partial<StoredTrackedChange>[], doc: string): TrackedChange[] {
  const placed: TrackedChange[] = [];
  for (const item of stored) {
    if ((item.kind !== "insert" && item.kind !== "delete") || typeof item.text !== "string" || !item.text) continue;
    const base: TrackedChange = {
      id: item.id || nextId(Date.now()),
      kind: item.kind,
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      text: item.text,
      author: item.author ?? "",
      createdAtMs: Number(item.createdAtMs) || 0,
    };
    const before = item.before ?? "";
    const after = item.after ?? "";
    if (base.kind === "insert") {
      if (doc.slice(base.from, base.to) === base.text) {
        placed.push(base);
        continue;
      }
      const withContext = nearestOccurrence(doc, before + base.text + after, base.from - before.length);
      const at = withContext >= 0 ? withContext + before.length : nearestOccurrence(doc, base.text, base.from);
      if (at >= 0) placed.push({ ...base, from: at, to: at + base.text.length });
      continue;
    }
    if (doc.slice(base.from - before.length, base.from) === before && doc.slice(base.from, base.from + after.length) === after
      && base.from <= doc.length && (before || after || base.from === 0)) {
      placed.push({ ...base, to: base.from });
      continue;
    }
    const around = before || after ? nearestOccurrence(doc, before + after, base.from - before.length) : -1;
    if (around >= 0) placed.push({ ...base, from: around + before.length, to: around + before.length });
  }
  return normalized(placed);
}

// ── Display ────────────────────────────────────────────────────────────────

class DeletedTextWidget extends WidgetType {
  constructor(readonly change: TrackedChange) {
    super();
  }

  eq(other: DeletedTextWidget) {
    return other.change.id === this.change.id && other.change.text === this.change.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-tracked-delete";
    span.dataset.trackedId = this.change.id;
    const shown = this.change.text.replace(/\n/g, "⏎");
    span.textContent = shown.length > 160 ? `${shown.slice(0, 160)}…` : shown;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

function decorationsFor(changes: TrackedChange[], length: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const change of changes) {
    const from = Math.min(change.from, length);
    if (change.kind === "insert") {
      const to = Math.min(change.to, length);
      if (to > from) ranges.push(Decoration.mark({ class: "cm-tracked-insert", attributes: { "data-tracked-id": change.id } }).range(from, to));
    } else {
      ranges.push(Decoration.widget({ widget: new DeletedTextWidget(change), side: -1 }).range(from));
    }
  }
  return Decoration.set(ranges, true);
}

export interface TrackChangesState {
  changes: TrackedChange[];
  recording: { enabled: boolean; author: string } | null;
  decorations: DecorationSet;
}

export const trackChangesField = StateField.define<TrackChangesState>({
  create: () => ({ changes: [], recording: null, decorations: Decoration.none }),
  update(value, transaction) {
    let { changes, recording } = value;
    if (transaction.docChanged) {
      const recorded = Boolean(recording?.enabled)
        && transaction.annotation(Transaction.addToHistory) !== false
        && !transaction.annotation(untrackedEdit);
      changes = recorded
        ? recordTrackedEdit(changes, transaction, recording!.author)
        : mapTrackedChanges(changes, transaction.changes, transaction.newDoc);
    }
    for (const effect of transaction.effects) {
      if (effect.is(setTrackedChanges)) changes = normalized(effect.value);
      else if (effect.is(resolveTrackedChanges)) {
        const ids = new Set(effect.value);
        changes = changes.filter((change) => !ids.has(change.id));
      } else if (effect.is(setTrackChangesRecording)) recording = effect.value;
    }
    if (changes === value.changes && recording === value.recording) return value;
    const decorations = changes === value.changes
      ? value.decorations
      : decorationsFor(changes, transaction.newDoc.length);
    return { changes, recording, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const trackedTooltip = hoverTooltip((view, position): Tooltip | null => {
  const { changes } = view.state.field(trackChangesField);
  const hits = changes.filter((change) => change.kind === "insert"
    ? position >= change.from && position <= change.to
    : Math.abs(position - change.from) <= 1);
  if (hits.length === 0) return null;
  return {
    pos: Math.min(...hits.map((hit) => hit.from)),
    end: Math.max(...hits.map((hit) => hit.to)),
    above: true,
    create() {
      const language = useStore.getState().language;
      const dom = document.createElement("div");
      dom.className = "cm-tracked-card";
      for (const hit of hits) {
        const row = document.createElement("div");
        row.className = `cm-tracked-card-item ${hit.kind}`;
        const label = document.createElement("span");
        label.textContent = `${hit.kind === "insert" ? tr(language, "插入", "Inserted", "Insertado") : tr(language, "删除", "Deleted", "Eliminado")} · ${hit.author}`;
        row.append(label);
        for (const action of ["accept", "reject"] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = action;
          button.textContent = action === "accept" ? tr(language, "接受", "Accept", "Aceptar") : tr(language, "拒绝", "Reject", "Rechazar");
          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            view.dom.dispatchEvent(new CustomEvent<TrackedChangeEventDetail>(TRACKED_CHANGE_EVENT, { bubbles: true, detail: { id: hit.id, action } }));
          });
          row.append(button);
        }
        dom.append(row);
      }
      return { dom };
    },
  };
}, { hoverTime: 300 });

/** Tracked insertions and deletions, drawn in the text with their accept/reject card. */
export function trackChanges(): Extension {
  return [trackChangesField, trackedTooltip];
}
