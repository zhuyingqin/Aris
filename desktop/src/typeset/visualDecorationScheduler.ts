import { StateEffect } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { LATEX_ANALYSIS_IDLE_MS } from "./latexStructure";

/** Requests a structural/decorative refresh after the editor has been idle. */
export const reparseVisualLatex = StateEffect.define<void>();

export const VISUAL_REPARSE_IDLE_MS = LATEX_ANALYSIS_IDLE_MS;

/**
 * Coalesces structural edits into one decoration rebuild. Ordinary prose edits
 * have already mapped the semantic index; this timer then reconciles the DOM
 * decoration set with that index without reparsing the source.
 */
export const visualDecorationScheduler = ViewPlugin.define((view) => {
  let timer: number | null = null;
  const schedule = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      view.dispatch({ effects: reparseVisualLatex.of(undefined) });
    }, VISUAL_REPARSE_IDLE_MS);
  };
  return {
    update(update) {
      if (update.docChanged) schedule();
    },
    destroy() {
      if (timer != null) window.clearTimeout(timer);
    },
  };
});
