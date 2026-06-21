import { useLayoutEffect, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import latex from "highlight.js/lib/languages/latex";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Register common Lab/file-editor languages without pulling in the full build.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("latex", latex);
hljs.registerLanguage("python", python);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const INDENT = "    "; // 4 spaces, the Python convention.

export type EditorLanguage =
  | "bash"
  | "css"
  | "ini"
  | "javascript"
  | "json"
  | "latex"
  | "python"
  | "markdown"
  | "powershell"
  | "rust"
  | "sql"
  | "text"
  | "typescript"
  | "xml"
  | "yaml";

const HIGHLIGHT_LANGUAGES = new Set<EditorLanguage>([
  "bash",
  "css",
  "ini",
  "javascript",
  "json",
  "latex",
  "python",
  "markdown",
  "powershell",
  "rust",
  "sql",
  "typescript",
  "xml",
  "yaml",
]);

interface CodeEditorProps {
  value: string;
  language: EditorLanguage;
  onChange: (value: string) => void;
  /** Called before the editor's own Tab/Enter handling — preventDefault to win. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  /** Stamped as `data-editor` on the textarea so the parent can focus it by index. */
  dataEditor?: number;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(code: string, language: EditorLanguage): string {
  if (HIGHLIGHT_LANGUAGES.has(language)) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      /* fall through to plain escaping */
    }
  }
  return escapeHtml(code);
}

/**
 * A lightweight code editor: a transparent <textarea> layered over a
 * syntax-highlighted <pre>. The two share identical typography and wrapping, so
 * the caret and selection (textarea) sit exactly over the colored tokens (pre).
 * This is the same overlay technique editors like react-simple-code-editor use —
 * no heavyweight CodeMirror/Monaco dependency, and it renders cleanly in jsdom.
 */
export default function CodeEditor({
  value,
  language,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  placeholder,
  readOnly,
  dataEditor,
}: CodeEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  const html = useMemo(() => highlight(value, language), [value, language]);

  // After a programmatic edit (indent / auto-indent) restore the caret once the
  // controlled value has flushed to the DOM.
  useLayoutEffect(() => {
    if (pendingSelection.current && taRef.current) {
      const [start, end] = pendingSelection.current;
      taRef.current.setSelectionRange(start, end);
      pendingSelection.current = null;
    }
  }, [value]);

  const commit = (next: string, selStart: number, selEnd: number) => {
    pendingSelection.current = [selStart, selEnd];
    onChange(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || readOnly) return;

    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;

    if (event.key === "Tab") {
      event.preventDefault();
      if (start === end && !event.shiftKey) {
        commit(value.slice(0, start) + INDENT + value.slice(end), start + INDENT.length, start + INDENT.length);
        return;
      }
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const lines = value.slice(lineStart, end).split("\n");
      if (event.shiftKey) {
        let removedFirst = 0;
        let removedTotal = 0;
        const dedented = lines.map((line, i) => {
          const removed = (line.match(/^ {1,4}/)?.[0].length ?? 0);
          if (i === 0) removedFirst = removed;
          removedTotal += removed;
          return line.slice(removed);
        });
        commit(
          value.slice(0, lineStart) + dedented.join("\n") + value.slice(end),
          Math.max(lineStart, start - removedFirst),
          end - removedTotal,
        );
      } else {
        const added = INDENT.length * lines.length;
        commit(
          value.slice(0, lineStart) + lines.map((line) => INDENT + line).join("\n") + value.slice(end),
          start + INDENT.length,
          end + added,
        );
      }
      return;
    }

    // Plain Enter: keep the previous line's indentation, plus one level after a
    // Python block opener (`:`). Run shortcuts (Shift/Ctrl/Alt+Enter) are handled
    // by the parent's onKeyDown above and never reach here.
    if (event.key === "Enter" && start === end && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const currentLine = value.slice(lineStart, start);
      let indent = currentLine.match(/^[ \t]*/)?.[0] ?? "";
      if (language === "python" && /:\s*$/.test(currentLine)) indent += INDENT;
      event.preventDefault();
      const insert = "\n" + indent;
      commit(value.slice(0, start) + insert + value.slice(end), start + insert.length, start + insert.length);
    }
  };

  return (
    <div className="lab-editor" data-lang={language}>
      <pre className="lab-editor-pre" aria-hidden="true">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      <textarea
        ref={taRef}
        data-editor={dataEditor}
        className="lab-editor-input"
        value={value}
        rows={1}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </div>
  );
}
