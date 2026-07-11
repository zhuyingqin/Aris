// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedEditor } from "../SharedEditor";
import type { SharedEditorHandle } from "../editorTypes";

afterEach(cleanup);

describe("SharedEditor", () => {
  it("creates exactly one EditorView per mount and destroys it on unmount", () => {
    const ready = vi.fn();
    const { unmount, rerender } = render(
      <SharedEditor doc="hello" language="text" surface="code" onReady={ready} />,
    );
    expect(ready).toHaveBeenCalledTimes(1);
    const handle = ready.mock.calls[0][0] as SharedEditorHandle;
    expect(handle.getText()).toBe("hello");

    // A re-render with the same logical props must not recreate the EditorView.
    rerender(<SharedEditor doc="hello" language="text" surface="code" onReady={ready} />);
    expect(ready).toHaveBeenCalledTimes(1);

    unmount();
    expect(ready).toHaveBeenCalledTimes(2);
    expect(ready.mock.calls[1][0]).toBeNull();
  });

  it("reconciles external doc prop changes without recreating the view", () => {
    const box: { handle: SharedEditorHandle | null } = { handle: null };
    const onReady = (h: SharedEditorHandle | null) => {
      box.handle = h;
    };
    const { rerender } = render(<SharedEditor doc="one" language="text" surface="code" onReady={onReady} />);
    const view = box.handle?.view;
    rerender(<SharedEditor doc="one two" language="text" surface="code" onReady={onReady} />);
    expect(box.handle?.view).toBe(view);
    expect(box.handle?.getText()).toBe("one two");
  });

  it("calls onUpdate with docChanged when a transaction is dispatched", () => {
    const onUpdate = vi.fn();
    const box: { handle: SharedEditorHandle | null } = { handle: null };
    render(
      <SharedEditor
        doc="abc"
        language="text"
        surface="code"
        onUpdate={onUpdate}
        onReady={(h) => {
          box.handle = h;
        }}
      />,
    );
    act(() => {
      box.handle?.dispatch({ changes: { from: 3, to: 3, insert: "d" } });
    });
    expect(onUpdate).toHaveBeenCalled();
    const calls = onUpdate.mock.calls;
    const lastUpdate = calls[calls.length - 1][0];
    expect(lastUpdate.docChanged).toBe(true);
    expect(box.handle?.getText()).toBe("abcd");
  });
});
