/**
 * Renders assistant text with:
 *  - <think>…</think> blocks collapsed (show/hide toggle)
 *  - Full markdown via react-markdown + remark-gfm
 *  - Code blocks with language badge + copy button
 *  - Syntax highlighting via highlight.js (github-dark theme)
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

// ── Think-block parser ────────────────────────────────────────────────────────

interface Segment {
  kind: "text" | "think";
  content: string;
}

function parseThinkBlocks(raw: string): Segment[] {
  const segments: Segment[] = [];
  const re = /<think>([\s\S]*?)<\/think>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) segments.push({ kind: "text", content: raw.slice(last, m.index) });
    segments.push({ kind: "think", content: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < raw.length) segments.push({ kind: "text", content: raw.slice(last) });
  return segments;
}

// ── Code block with copy ──────────────────────────────────────────────────────

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = (className ?? "").replace("language-", "") || "text";
  const code = String(children ?? "").replace(/\n$/, "");

  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{lang}</span>
        <button className="md-code-copy" onClick={copy}>
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <code className={className}>{children}</code>
    </div>
  );
}

// ── Think-block toggle ────────────────────────────────────────────────────────

export function ThinkBlock({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(streaming);
  const preview = content.slice(0, 80).replace(/\s+/g, " ");
  return (
    <div className="md-think">
      <button className="md-think-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="md-think-icon">{open ? "▾" : "▸"}</span>
        <span className="md-think-label">Thinking</span>
        {!open && <span className="md-think-preview">{preview}{content.length > 80 ? "…" : ""}</span>}
      </button>
      {open && (
        <div className="md-think-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function MarkdownContent({ text, streaming }: { text: string; streaming?: boolean }) {
  const segments = parseThinkBlocks(text);

  return (
    <div className="md-content">
      {segments.map((seg, i) => {
        if (seg.kind === "think") {
          return <ThinkBlock key={i} content={seg.content} />;
        }
        const content = streaming && i === segments.length - 1
          ? seg.content  // cursor handled by parent
          : seg.content;
        if (!content.trim()) return null;
        return (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              // Code blocks — use our custom renderer
              pre({ children }) {
                return <>{children}</>;
              },
              code({ className, children, ...props }) {
                const isBlock = className?.startsWith("language-");
                if (isBlock) {
                  return <CodeBlock className={className}>{children}</CodeBlock>;
                }
                return <code className="md-inline-code" {...props}>{children}</code>;
              },
              // Open links externally
              a({ href, children }) {
                return (
                  <a href={href} target="_blank" rel="noreferrer" className="md-link">
                    {children}
                  </a>
                );
              },
            }}
          >
            {content}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}
