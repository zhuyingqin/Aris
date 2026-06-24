import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { fileOpen } from "../api/tauri";
import { useStore } from "../store";

const MAX_MARKDOWN_RENDER_CHARS = 80_000;
const LARGE_MARKDOWN_HEAD_CHARS = 48_000;
const LARGE_MARKDOWN_TAIL_CHARS = 16_000;

interface Segment {
  kind: "text" | "think";
  content: string;
}

function largeTextExcerpt(text: string): string {
  if (text.length <= LARGE_MARKDOWN_HEAD_CHARS + LARGE_MARKDOWN_TAIL_CHARS) return text;
  const omitted = text.length - LARGE_MARKDOWN_HEAD_CHARS - LARGE_MARKDOWN_TAIL_CHARS;
  return [
    text.slice(0, LARGE_MARKDOWN_HEAD_CHARS),
    `\n\n[SomniQ is showing a lightweight preview of this large message; ${omitted.toLocaleString()} characters are hidden here. Use Copy on the message for the full text.]\n\n`,
    text.slice(-LARGE_MARKDOWN_TAIL_CHARS),
  ].join("");
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

function isExternalHref(href: string): boolean {
  return href.startsWith("#") || /^(https?:|mailto:)/i.test(href);
}

function decodeLocalHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export function studioArtifactIdFromHref(href: string): string | null {
  const normalized = href.replace(/^\.\//, "");
  const prefix = "studio/artifact/";
  if (!normalized.startsWith(prefix)) return null;
  const encoded = normalized.slice(prefix.length).split(/[?#]/, 1)[0];
  return encoded ? decodeLocalHref(encoded) : null;
}

function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const setTab = useStore((state) => state.setTab);
  const setPendingStudioArtifactId = useStore((state) => state.setPendingStudioArtifactId);
  const studioArtifactId = href ? studioArtifactIdFromHref(href) : null;
  if (studioArtifactId) {
    return (
      <a
        href={href}
        className="md-link md-studio-link"
        title="Open result in Studio"
        onClick={(event) => {
          event.preventDefault();
          setPendingStudioArtifactId(studioArtifactId);
          setTab("studio");
        }}
      >
        {children}
      </a>
    );
  }
  if (!href || isExternalHref(href)) {
    return <a href={href} target="_blank" rel="noreferrer" className="md-link">{children}</a>;
  }
  return (
    <a
      href={href}
      className="md-link md-local-link"
      title="Open local file"
      onClick={(event) => {
        event.preventDefault();
        void fileOpen(decodeLocalHref(href)).catch((error) => console.error("Unable to open file", error));
      }}
    >
      {children}
    </a>
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
  const [elapsedSec, setElapsedSec] = useState(0);
  const startRef = useRef<number | null>(null);
  const wasStreaming = useRef(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!streaming) {
      if (startRef.current !== null) {
        setElapsedSec(Math.round((Date.now() - startRef.current) / 1000));
        startRef.current = null;
      }
      return;
    }
    startRef.current = Date.now();
    setElapsedSec(0);
    const id = window.setInterval(() => {
      setElapsedSec(Math.round((Date.now() - startRef.current!) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [streaming]);

  // Collapse once thinking finishes (streaming true → false), but leave the
  // user free to re-open it afterwards.
  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  // Keep the bounded body pinned to the newest thinking text while it streams.
  useEffect(() => {
    if (streaming && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, streaming, open]);

  const preview = content.slice(0, 80).replace(/\s+/g, " ");
  const label = streaming
    ? `正在思考${elapsedSec > 0 ? ` · ${elapsedSec}s` : ""}`
    : elapsedSec > 0
      ? `已处理 ${elapsedSec}s`
      : "已思考";

  return (
    <div className={`md-think${streaming ? " md-think-active" : ""}`}>
      <button className="md-think-toggle" onClick={() => setOpen((value) => !value)}>
        <span className="md-think-icon">{open ? "▾" : "▸"}</span>
        {streaming && <span className="md-think-spinner" aria-hidden="true" />}
        <span className="md-think-label">{label}</span>
        {!streaming && !open && content && (
          <span className="md-think-preview">{preview}{content.length > 80 ? "..." : ""}</span>
        )}
      </button>
      {open && (
        <div className="md-think-body" ref={bodyRef}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
});

function MarkdownContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const rendered = useThrottledText(text, streaming);
  if (rendered.length > MAX_MARKDOWN_RENDER_CHARS) {
    return (
      <div className="md-content md-content-large">
        <div className="md-large-notice">
          Large response preview
        </div>
        <pre className="md-large-text">{largeTextExcerpt(rendered)}</pre>
      </div>
    );
  }
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
                return <MarkdownLink href={href}>{children}</MarkdownLink>;
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
