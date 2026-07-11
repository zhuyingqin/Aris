import { useEffect, useMemo, useRef } from "react";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension, type KeyBinding } from "@codemirror/view";
import { SharedEditor } from "../editor/SharedEditor";
import { diffDecorations, dispatchDiffLines, type CodeDiffLine } from "../editor/editorDecorations";
import type { EditorLanguage, EditorUpdate, SharedEditorHandle } from "../editor/editorTypes";

export type { EditorLanguage } from "../editor/editorTypes";
export type { CodeDiffLine } from "../editor/editorDecorations";

interface CodeEditorProps {
  value: string;
  language: EditorLanguage;
  onChange: (value: string) => void;
  diffLines?: CodeDiffLine[];
  /**
   * Extra CodeMirror key bindings, given top precedence over the shared
   * kernel's own keymap (e.g. Shift+Enter to run a selection, cell navigation).
   * Replaces the old React-`KeyboardEvent`-interception `onKeyDown` prop.
   */
  extraKeymap?: KeyBinding[];
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  /** Wrap long lines (notebook cells) vs. horizontal-scroll them (file editor). Defaults to true. */
  wrap?: boolean;
  /** Stamped as `data-editor` so the parent can focus this editor by index (see Lab.tsx). */
  dataEditor?: number | string;
  /** Hands the live editor handle up to the caller (selection reads, imperative focus, …). */
  onReady?: (handle: SharedEditorHandle | null) => void;
  /** Double-click forward-search: reports the 1-based line/column under the click (e.g. to jump a LaTeX PDF preview to that position). */
  onDoubleClickPos?: (line: number, column: number) => void;
}

export default function CodeEditor({
  value,
  language,
  onChange,
  onFocus,
  onBlur,
  placeholder,
  readOnly,
  wrap = true,
  dataEditor,
  onReady,
  extraKeymap,
  diffLines,
  onDoubleClickPos,
}: CodeEditorProps) {
  const handleRef = useRef<SharedEditorHandle | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Read via ref (not the memoized extensions closure directly) so a later
  // prop change is still picked up without recreating the editor extensions.
  const onDoubleClickPosRef = useRef(onDoubleClickPos);
  onDoubleClickPosRef.current = onDoubleClickPos;

  // Extensions are a creation-time input to SharedEditor (see its docs) — this
  // only needs to compute the *initial* set once per mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const extensions = useMemo(() => {
    const list = [
      EditorView.domEventHandlers({
        focus: () => {
          onFocus?.();
          return false;
        },
        blur: () => {
          onBlur?.();
          return false;
        },
        dblclick: (event, view) => {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          // eslint-disable-next-line no-console -- temporary forward-search diagnostic, see conversation
          console.debug("[typeset] Code dblclick", { clientX: event.clientX, clientY: event.clientY, pos, hasCallback: Boolean(onDoubleClickPosRef.current) });
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          onDoubleClickPosRef.current?.(line.number, pos - line.from + 1);
          return false;
        },
      }),
      diffDecorations(diffLines),
    ];
    if (wrap) list.push(EditorView.lineWrapping);
    if (placeholder) list.push(placeholderExtension(placeholder));
    if (extraKeymap?.length) list.push(Prec.high(keymap.of(extraKeymap)));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (handleRef.current) dispatchDiffLines(handleRef.current.view, diffLines ?? []);
  }, [diffLines]);

  const handleUpdate = (update: EditorUpdate) => {
    if (update.docChanged) onChangeRef.current(update.state.doc.toString());
  };

  const handleReady = (handle: SharedEditorHandle | null) => {
    handleRef.current = handle;
    onReady?.(handle);
  };

  return (
    <SharedEditor
      className="lab-editor"
      doc={value}
      language={language}
      surface="code"
      readOnly={readOnly}
      dataEditor={dataEditor !== undefined ? String(dataEditor) : undefined}
      extensions={extensions}
      onUpdate={handleUpdate}
      onReady={handleReady}
    />
  );
}
