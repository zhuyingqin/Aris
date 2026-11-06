import type { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type VisualScrollAnchor = { pos: number; top: number };

/** Keep the clicked source line at its previous screen height when a visual
 * block opens or an earlier block closes. A raw scrollTop snapshot cannot do
 * this: source above the click may change height. CodeMirror must apply this
 * after it has measured the final decorations, using the actual outer scroller. */
export function visualClickScrollEffect(
  view: EditorView,
  anchor?: VisualScrollAnchor,
): StateEffect<unknown> | null {
  const selection = view.state.selection.main;
  if (!selection.empty) return null;
  const scroller = view.dom.closest<HTMLElement>(".typeset-visual-scroll") ?? view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  if (rect.height <= 0) return null;
  const pos = anchor?.pos ?? selection.head;
  const top = anchor?.top ?? view.coordsAtPos(pos)?.top;
  if (top == null) return null;
  const margin = Math.max(0, Math.min(rect.height - 1, top - rect.top));
  return EditorView.scrollIntoView(pos, { y: "start", yMargin: margin });
}
