import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import {
  anchorTrackedChanges,
  rejectedText,
  resolveTrackedChanges,
  setTrackChangesRecording,
  storedTrackedChanges,
  trackChangesField,
  untrackedEdit,
  type TrackedChange,
} from "../trackChanges";

function recordingState(doc: string) {
  let state = EditorState.create({ doc, extensions: [trackChangesField, history()] });
  state = state.update({ effects: setTrackChangesRecording.of({ enabled: true, author: "Ann" }) }).state;
  return state;
}

const apply = (state: EditorState, spec: TransactionSpec) => state.update(spec).state;
const tracked = (state: EditorState) => state.field(trackChangesField).changes.map(({ kind, from, to, text }) => ({ kind, from, to, text }));

/** Runs a CodeMirror command against a plain state. */
function run(state: EditorState, command: typeof undo): EditorState {
  let next = state;
  command({ state, dispatch: (transaction: Transaction) => { next = transaction.state; } });
  return next;
}

describe("recording tracked changes", () => {
  it("marks typed text as one insertion, and keeps the text the accepted version", () => {
    let state = recordingState("Deep nets.");
    for (const [index, char] of [..." work"].entries()) {
      state = apply(state, { changes: { from: 9 + index, insert: char }, userEvent: "input.type" });
    }
    expect(state.doc.toString()).toBe("Deep nets work.");
    expect(tracked(state)).toEqual([{ kind: "insert", from: 9, to: 14, text: " work" }]);
  });

  it("joins a run of backspaces into one deletion, in reading order", () => {
    let state = recordingState("Deep nets.");
    for (let at = 9; at > 5; at -= 1) state = apply(state, { changes: { from: at - 1, to: at }, userEvent: "delete.backward" });
    expect(state.doc.toString()).toBe("Deep .");
    expect(tracked(state)).toEqual([{ kind: "delete", from: 5, to: 5, text: "nets" }]);
    expect(rejectedText(state.doc.toString(), state.field(trackChangesField).changes)).toBe("Deep nets.");
  });

  it("leaves no trace when one's own insertion is deleted again", () => {
    let state = recordingState("Deep nets.");
    state = apply(state, { changes: { from: 4, insert: " big" } });
    state = apply(state, { changes: { from: 4, to: 8 } });
    expect(state.doc.toString()).toBe("Deep nets.");
    expect(tracked(state)).toEqual([]);
  });

  it("deleting across an insertion records only the original text", () => {
    let state = recordingState("ab cd");
    state = apply(state, { changes: { from: 2, insert: "XY" } });
    state = apply(state, { changes: { from: 0, to: 7 } });
    expect(tracked(state)).toEqual([{ kind: "delete", from: 0, to: 0, text: "ab cd" }]);
  });

  it("cancels a deletion when undo puts the text back", () => {
    let state = recordingState("Deep nets.");
    state = apply(state, { changes: { from: 4, to: 9 }, userEvent: "delete" });
    expect(tracked(state)).toEqual([{ kind: "delete", from: 4, to: 4, text: " nets" }]);
    state = run(state, undo);
    expect(state.doc.toString()).toBe("Deep nets.");
    expect(tracked(state)).toEqual([]);
  });

  it("records only the changed middle of a replacement", () => {
    let state = recordingState("the colour red");
    state = apply(state, { changes: { from: 4, to: 10, insert: "color" } });
    expect(tracked(state)).toEqual([{ kind: "delete", from: 8, to: 8, text: "u" }]);
    state = apply(state, { changes: { from: 4, to: 9, insert: "hue" } });
    // "colo" + ghost "u" + "r" replaced by "hue": the whole original word is gone.
    expect(tracked(state)).toEqual([
      { kind: "delete", from: 4, to: 4, text: "colour" },
      { kind: "insert", from: 4, to: 7, text: "hue" },
    ]);
  });

  it("only maps changes for edits that are not recorded", () => {
    let state = recordingState("Deep nets.");
    state = apply(state, { changes: { from: 4, insert: " big" } });
    state = apply(state, { changes: { from: 0, insert: "% x\n" }, annotations: Transaction.addToHistory.of(false) });
    state = apply(state, { changes: { from: 4, insert: "Very " }, annotations: untrackedEdit.of(true) });
    expect(tracked(state)).toEqual([{ kind: "insert", from: 13, to: 17, text: " big" }]);
    state = apply(state, { effects: setTrackChangesRecording.of({ enabled: false, author: "Ann" }) });
    state = apply(state, { changes: { from: 0, insert: "!" } });
    expect(tracked(state)).toEqual([{ kind: "insert", from: 14, to: 18, text: " big" }]);
  });

  it("drops resolved changes", () => {
    let state = recordingState("Deep nets.");
    state = apply(state, { changes: { from: 4, insert: " big" } });
    const [change] = state.field(trackChangesField).changes;
    state = apply(state, { effects: resolveTrackedChanges.of([change.id]) });
    expect(tracked(state)).toEqual([]);
  });
});

describe("stored tracked changes", () => {
  const changes: TrackedChange[] = [
    { id: "i", kind: "insert", from: 4, to: 8, text: " big", author: "Ann", createdAtMs: 1 },
    { id: "d", kind: "delete", from: 13, to: 13, text: " work", author: "Ann", createdAtMs: 1 },
  ];
  const doc = "Deep big nets.";

  it("find their place again after the text moved, and drop what no longer fits", () => {
    const stored = storedTrackedChanges(changes, doc);
    expect(anchorTrackedChanges(stored, doc).map((change) => change.from)).toEqual([4, 13]);

    const moved = `% preamble\n${doc}`;
    expect(anchorTrackedChanges(stored, moved).map((change) => [change.kind, change.from])).toEqual([["insert", 15], ["delete", 24]]);

    const rewritten = "Shallow nets.";
    expect(anchorTrackedChanges(stored, rewritten)).toEqual([]);
  });
});
