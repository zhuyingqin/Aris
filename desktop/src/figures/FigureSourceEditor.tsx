import { useMemo, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { SharedEditor } from "../editor/SharedEditor";

export default function FigureSourceEditor({ value, readOnly, onChange }: {
  value: string; readOnly: boolean; onChange: (svg: string) => void;
}) {
  const valueRef = useRef(value); valueRef.current = value;
  const extensions = useMemo(() => [
    EditorView.contentAttributes.of({ "aria-label": "SVG", role: "textbox", "aria-multiline": "true", spellcheck: "false" }),
    EditorView.lineWrapping,
  ], []);
  return <SharedEditor className="figure-source" doc={value} language="xml" surface="code"
    readOnly={readOnly} dataEditor="figure-svg-source" extensions={extensions}
    onUpdate={(update) => {
      const svg = update.state.doc.toString();
      // Loading an AI result or a saved version is not a new user edit.
      if (update.docChanged && svg !== valueRef.current) onChange(svg);
    }} />;
}
