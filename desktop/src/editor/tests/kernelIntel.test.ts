// @vitest-environment jsdom

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { MutableRefObject } from "react";
import { describe, expect, it } from "vitest";

import { kernelCompletionSource, stripAnsi, type CompleteFn } from "../kernelIntel";

function contextFor(doc: string, pos = doc.length, explicit = false): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit);
}

const refOf = (fn: CompleteFn | undefined): MutableRefObject<CompleteFn | undefined> => ({ current: fn });

describe("kernelCompletionSource", () => {
  it("maps kernel matches to a result anchored at cursorStart..cursor", async () => {
    const source = kernelCompletionSource(
      refOf(async () => ({ matches: ["path", "pathconf"], cursorStart: 3, cursorEnd: 5 })),
    );
    const result = await source(contextFor("os.pa"));
    expect(result).not.toBeNull();
    expect(result!.from).toBe(3);
    expect(result!.to).toBe(5);
    expect(result!.options.map((option) => option.label)).toEqual(["path", "pathconf"]);
  });

  it("returns null with no query fn, no matches, or a thrown error", async () => {
    expect(await kernelCompletionSource(refOf(undefined))(contextFor("os.pa"))).toBeNull();
    expect(
      await kernelCompletionSource(refOf(async () => ({ matches: [], cursorStart: 0, cursorEnd: 0 })))(
        contextFor("os.pa"),
      ),
    ).toBeNull();
    expect(
      await kernelCompletionSource(refOf(async () => {
        throw new Error("kernel down");
      }))(contextFor("os.pa")),
    ).toBeNull();
  });

  it("stays quiet on whitespace unless completion is explicit", async () => {
    const source = kernelCompletionSource(
      refOf(async () => ({ matches: ["print"], cursorStart: 6, cursorEnd: 6 })),
    );
    // Caret sits after a newline (no identifier before it): implicit → nothing.
    expect(await source(contextFor("os.pa\n", 6, false))).toBeNull();
    // Explicit invoke (Ctrl-Space) bypasses the gate.
    expect(await source(contextFor("os.pa\n", 6, true))).not.toBeNull();
  });

  it("clamps an out-of-range cursorStart to the caret", async () => {
    const source = kernelCompletionSource(
      refOf(async () => ({ matches: ["x"], cursorStart: 999, cursorEnd: 999 })),
    );
    const result = await source(contextFor("value"));
    expect(result!.from).toBe(5);
  });
});

describe("stripAnsi", () => {
  it("removes SGR color escapes from a docstring", () => {
    expect(stripAnsi("[31mSignature:[0m foo(x)")).toBe("Signature: foo(x)");
  });
});
