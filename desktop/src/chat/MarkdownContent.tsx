import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

interface Segment {
  kind: "text" | "think";
  content: string;
}

function parseThinkBlocks(raw: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /<think>([\s\S]*?)<\/think>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > last) segments.push({ kind: "text", content: raw.slice(last, match.index) });
    segments.push({ kind: "think", content: match[1].trim() });
    last = match.index + match[0].length;
  }
  if (last < raw.length) segments.push({ kind: "text", content: raw.slice(last) });
  return segments;
}

function useThrottledText(text: string, streaming: boolean) {
  const [rendered, setRendered] = useState(text);
  const latest = useRef(text);
  const timer = useRef<number | null>(null);
  latest.current = text;

  useEffect(() => {
    if (!streaming) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setRendered(text);
      return;
    }
    if (timer.current === null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setRendered(latest.current);
      }, 100);
    }
  }, [streaming, text]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return rendered;
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = (className ?? "").replace("language-", "") || "text";
  const code = String(children ?? "").replace(/\n$/, "");
  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{language}</span>
        <button
          className="md-code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code className={className}>{children}</code>
    </div>
  );
}

export const ThinkBlock = memo(function ThinkBlock({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const preview = content.slice(0, 80).replace(/\s+/g, " ");
  return (
    <div className="md-think">
      <button className="md-think-toggle" onClick={() => setOpen((value) => !value)}>
        <span className="md-think-icon">{open ? "▾" : "▸"}</span>
        <span className="md-think-label">Thinking</span>
        {!open && <span className="md-think-preview">{preview}{content.length > 80 ? "..." : ""}</span>}
      </button>
      {open && <div className="md-think-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>}
    </div>
  );
});

function MarkdownContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const rendered = useThrottledText(text, streaming);
  const segments = parseThinkBlocks(rendered);
  return (
    <div className="md-content">
      {segments.map((segment, index) => {
        if (segment.kind === "think") return <ThinkBlock key={index} content={segment.content} />;
        if (!segment.content.trim()) return null;
        return (
          <ReactMarkdown
            key={index}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre({ children }) {
                return <>{children}</>;
              },
              code({ className, children, ...props }) {
                return className?.startsWith("language-")
                  ? <CodeBlock className={className}>{children}</CodeBlock>
                  : <code className="md-inline-code" {...props}>{children}</code>;
              },
              a({ href, children }) {
                return <a href={href} target="_blank" rel="noreferrer" className="md-link">{children}</a>;
              },
            }}
          >
            {segment.content}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}

export default memo(MarkdownContent);
