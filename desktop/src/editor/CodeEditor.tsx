import { useEffect, useMemo, useRef } from "react";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension, type KeyBinding } from "@codemirror/view";
import { SharedEditor } from "./SharedEditor";
import { diffDecorations, dispatchDiffLines, type CodeDiffLine } from "./editorDecorations";
import { kernelCompletion, kernelInspect, type CompleteFn, type InspectFn } from "./kernelIntel";
import { latexVscodeHighlighting } from "./latexVscodeHighlighting";
import type { EditorLanguage, EditorUpdate, SharedEditorHandle } from "./editorTypes";

export type { EditorLanguage } from "./editorTypes";
export type { CodeDiffLine } from "./editorDecorations";

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
  /** Stamped as `data-editor` so the parent can focus this editor by index. */
  dataEditor?: number | string;
  /** Hands the live editor handle up to the caller (selection reads, imperative focus, …). */
  onReady?: (handle: SharedEditorHandle | null) => void;
  /** Double-click forward-search: reports the 1-based line/column under the click (e.g. to jump a LaTeX PDF preview to that position). */
  onDoubleClickPos?: (line: number, column: number) => void;
  /** Kernel-backed autocomplete source (notebook cells). When set, replaces the
   *  language pack's keyword-only completion with `complete_request` results. */
  completeRequest?: CompleteFn;
  /** Kernel object introspection for Shift+Tab docs (notebook cells). */
  inspectRequest?: InspectFn;
  /** Applies the theme-aware VS Code-style LaTeX palette without changing other code surfaces. */
  latexVscodeTheme?: boolean;
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
  completeRequest,
  inspectRequest,
  latexVscodeTheme = false,
}: CodeEditorProps) {
  const handleRef = useRef<SharedEditorHandle | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Read via ref (not the memoized extensions closure directly) so a later
  // prop change is still picked up without recreating the editor extensions.
  const onDoubleClickPosRef = useRef(onDoubleClickPos);
  onDoubleClickPosRef.current = onDoubleClickPos;
  // Same ref indirection for the kernel-intel callbacks: extensions capture the
  // refs once at mount but always call whatever the latest render supplied.
  const completeRequestRef = useRef(completeRequest);
  completeRequestRef.current = completeRequest;
  const inspectRequestRef = useRef(inspectRequest);
  inspectRequestRef.current = inspectRequest;

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
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          onDoubleClickPosRef.current?.(line.number, pos - line.from + 1);
          return false;
        },
      }),
      diffDecorations(diffLines),
    ];
    if (latexVscodeTheme) list.push(latexVscodeHighlighting);
    if (wrap) list.push(EditorView.lineWrapping);
    if (placeholder) list.push(placeholderExtension(placeholder));
    if (extraKeymap?.length) list.push(Prec.high(keymap.of(extraKeymap)));
    // Kernel-backed intel for notebook cells: a `complete_request` source and a
    // Shift+Tab `inspect_request` popover. Gated on the mount-time props so
    // surfaces without a kernel (file editor, Typeset) keep language completion.
    if (completeRequest) list.push(kernelCompletion(completeRequestRef));
    if (inspectRequest) list.push(Prec.high(kernelInspect(inspectRequestRef)));
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
      className={`code-editor${latexVscodeTheme ? " typeset-latex-vscode" : ""}`}
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
