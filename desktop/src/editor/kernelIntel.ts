import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { keymap, showTooltip, type Tooltip } from "@codemirror/view";
import type { MutableRefObject } from "react";

/** Shape returned by the `lab_complete` kernel command (camelCased outcome). */
export interface KernelCompletion {
  matches: string[];
  cursorStart: number;
  cursorEnd: number;
}

/** Queries the kernel for completions at `cursorPos` (a document offset). */
export type CompleteFn = (code: string, cursorPos: number) => Promise<KernelCompletion | null>;

/** Queries the kernel for object docs; resolves to plain text or null. */
export type InspectFn = (code: string, cursorPos: number) => Promise<string | null>;

/** Strip ANSI SGR escapes so an IPython docstring reads cleanly in a tooltip. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex
}

/**
 * A CodeMirror completion source backed by the Jupyter kernel (`complete_request`
 * → jedi/IPython), replacing the language pack's keyword-only completion for the
 * notebook surface. Reads the query fn through a ref so a later kernel/notebook
 * switch is always honoured (the editor captures extensions once, at mount).
 */
/** The bare async completion source, exported for unit testing. */
export function kernelCompletionSource(ref: MutableRefObject<CompleteFn | undefined>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const fn = ref.current;
    if (!fn) return null;
    // Fire while typing an identifier / after a dot, or on explicit Ctrl-Space.
    const before = context.matchBefore(/[\w.]+/);
    if (!context.explicit && (!before || before.from === before.to)) return null;

    let result: KernelCompletion | null;
    try {
      result = await fn(context.state.doc.toString(), context.pos);
    } catch {
      return null;
    }
    if (!result || result.matches.length === 0) return null;

    const from = Math.max(0, Math.min(result.cursorStart, context.pos));
    const options: Completion[] = result.matches.slice(0, 200).map((label) => ({ label }));
    return { from, to: context.pos, options, validFor: /^[\w]*$/ };
  };
}

export function kernelCompletion(ref: MutableRefObject<CompleteFn | undefined>): Extension {
  return autocompletion({ override: [kernelCompletionSource(ref)] });
}

const setInspectTooltip = StateEffect.define<Tooltip | null>();

const inspectTooltipField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setInspectTooltip)) return effect.value;
    // Any edit or cursor move dismisses a shown docstring.
    if (value && (tr.docChanged || tr.selection)) return null;
    return value;
  },
  provide: (field) => showTooltip.from(field),
});

function inspectTooltip(pos: number, text: string): Tooltip {
  return {
    pos,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-kernel-inspect";
      const pre = document.createElement("pre");
      pre.textContent = text;
      dom.appendChild(pre);
      return { dom };
    },
  };
}

/**
 * Shift+Tab object inspection (`inspect_request`), Jupyter-style. Only intercepts
 * Shift+Tab when the caret sits on an identifier; otherwise it returns false so
 * the normal dedent still works. The docstring shows in a tooltip that clears on
 * the next edit or caret move.
 */
export function kernelInspect(ref: MutableRefObject<InspectFn | undefined>): Extension {
  return [
    inspectTooltipField,
    keymap.of([
      {
        key: "Shift-Tab",
        run: (view) => {
          const fn = ref.current;
          if (!fn) return false;
          const pos = view.state.selection.main.head;
          const before = view.state.doc.sliceString(Math.max(0, pos - 1), pos);
          if (!/[\w.]/.test(before)) return false; // let dedent handle it
          void fn(view.state.doc.toString(), pos)
            .then((text) => {
              view.dispatch({
                effects: setInspectTooltip.of(text && text.trim() ? inspectTooltip(pos, text) : null),
              });
            })
            .catch(() => undefined);
          return true;
        },
      },
    ]),
  ];
}
