import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, hoverTooltip, type DecorationSet, type Tooltip } from "@codemirror/view";
import { tr } from "../language";
import { useStore } from "../store";

/** One open comment as the editor shows it: where it sits and what it says. */
export interface CommentHighlight {
  id: string;
  from: number;
  to: number;
  author: string;
  body: string;
  replies: number;
}

/** Replaces the comments shown in a view (an empty list clears them). */
export const setCommentHighlights = StateEffect.define<CommentHighlight[]>();

/** Fired on the editor when a comment's card asks to open it in the panel. */
export const OPEN_COMMENT_EVENT = "typeset-open-comment";
export type OpenCommentEventDetail = { id: string };

/** A comment on a point (no selected text) is a small marker, not a mark. */
class CommentPointWidget extends WidgetType {
  constructor(readonly id: string) {
    super();
  }

  eq(other: CommentPointWidget) {
    return other.id === this.id;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = "cm-typeset-comment-point";
    marker.dataset.commentId = this.id;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  ignoreEvent() {
    return false;
  }
}

type CommentState = { highlights: CommentHighlight[]; decorations: DecorationSet };

function decorationsFor(highlights: CommentHighlight[], length: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const highlight of highlights) {
    const from = Math.max(0, Math.min(highlight.from, length));
    const to = Math.max(from, Math.min(highlight.to, length));
    ranges.push(to > from
      ? Decoration.mark({ class: "cm-typeset-comment", attributes: { "data-comment-id": highlight.id } }).range(from, to)
      : Decoration.widget({ widget: new CommentPointWidget(highlight.id), side: 1 }).range(from));
  }
  return Decoration.set(ranges, true);
}

const commentField = StateField.define<CommentState>({
  create: () => ({ highlights: [], decorations: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCommentHighlights)) {
        return { highlights: effect.value, decorations: decorationsFor(effect.value, transaction.newDoc.length) };
      }
    }
    if (!transaction.docChanged) return value;
    // Typing moves the marks with their text, as an edit moves a selection.
    const highlights = value.highlights.map((highlight) => {
      const from = transaction.changes.mapPos(highlight.from, 1);
      return { ...highlight, from, to: Math.max(from, transaction.changes.mapPos(highlight.to, -1)) };
    });
    return { highlights, decorations: value.decorations.map(transaction.changes) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The comment card shown when the pointer rests on commented text. */
const commentTooltip = hoverTooltip((view, position): Tooltip | null => {
  const { highlights } = view.state.field(commentField);
  const hits = highlights.filter((highlight) => position >= highlight.from && position <= Math.max(highlight.to, highlight.from + 1));
  if (hits.length === 0) return null;
  return {
    pos: Math.min(...hits.map((hit) => hit.from)),
    end: Math.max(...hits.map((hit) => hit.to)),
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-typeset-comment-card";
      for (const hit of hits) {
        const item = document.createElement("div");
        item.className = "cm-typeset-comment-card-item";
        const author = document.createElement("strong");
        author.textContent = hit.author;
        const body = document.createElement("p");
        body.textContent = hit.body.length > 280 ? `${hit.body.slice(0, 280)}…` : hit.body;
        const open = document.createElement("button");
        open.type = "button";
        const language = useStore.getState().language;
        open.textContent = hit.replies > 0 ? `💬 ${hit.replies}` : "💬";
        open.title = hit.replies > 0
          ? tr(language, `打开批注（${hit.replies} 条回复）`, `Open comment (${hit.replies} replies)`, `Abrir comentario (${hit.replies} respuestas)`)
          : tr(language, "打开批注", "Open comment", "Abrir comentario");
        open.setAttribute("aria-label", open.title);
        open.dataset.commentId = hit.id;
        open.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          view.dom.dispatchEvent(new CustomEvent<OpenCommentEventDetail>(OPEN_COMMENT_EVENT, { bubbles: true, detail: { id: hit.id } }));
        });
        item.append(author, body, open);
        dom.append(item);
      }
      return { dom };
    },
  };
}, { hoverTime: 350 });

/** Open comments highlighted in the source, with their text on hover. */
export function latexCommentHighlights(): Extension {
  return [commentField, commentTooltip];
}
