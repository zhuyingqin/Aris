import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { fileOpen } from "../api/tauri";
import { useStore } from "../store";
import MermaidDiagram from "./MermaidDiagram";

const MAX_MARKDOWN_RENDER_CHARS = 80_000;
const LARGE_MARKDOWN_HEAD_CHARS = 48_000;
const LARGE_MARKDOWN_TAIL_CHARS = 16_000;

interface Segment {
  kind: "text" | "think";
  content: string;
  open?: boolean;
}

interface MarkdownChunk {
  kind: "markdown" | "code";
  content: string;
}

interface ExtractedThinking {
  visibleText: string;
  thinkingText: string;
  thinkingOpen: boolean;
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

function markdownLinesWithEndings(raw: string): string[] {
  return raw.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function closingFencePattern(marker: string, length: number): RegExp {
  return new RegExp(`^ {0,3}${marker}{${length},}\\s*$`);
}

function splitMarkdownFences(raw: string): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let markdown = "";
  let code = "";
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const flushMarkdown = () => {
    if (markdown) chunks.push({ kind: "markdown", content: markdown });
    markdown = "";
  };
  const flushCode = () => {
    if (code) chunks.push({ kind: "code", content: code });
    code = "";
  };

  for (const line of markdownLinesWithEndings(raw)) {
    const body = line.replace(/(?:\r\n|\n|\r)$/, "");
    if (fence) {
      code += line;
      if (closingFencePattern(fence.marker, fence.length).test(body)) {
        flushCode();
        fence = null;
      }
      continue;
    }

    const open = body.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      flushMarkdown();
      const sequence = open[1];
      fence = { marker: sequence[0] as "`" | "~", length: sequence.length };
      code += line;
    } else {
      markdown += line;
    }
  }

  if (fence) flushCode();
  else flushMarkdown();
  return chunks;
}

function extractThinking(raw: string): ExtractedThinking {
  const thoughts: string[] = [];
  let visibleText = "";
  let currentThought = "";
  let inThink = false;
  const tagPattern = /<\s*\/\s*think(?:ing)?\s*>|<\s*think(?:ing)?\b[^>]*>/gi;

  const closeThought = () => {
    const trimmed = currentThought.trim();
    if (trimmed) thoughts.push(trimmed);
    currentThought = "";
    inThink = false;
  };

  for (const chunk of splitMarkdownFences(raw)) {
    if (chunk.kind === "code") {
      if (inThink) currentThought += chunk.content;
      else visibleText += chunk.content;
      continue;
    }

    tagPattern.lastIndex = 0;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(chunk.content)) !== null) {
      const tag = match[0];
      const isClose = /^<\s*\//.test(tag);
      const before = chunk.content.slice(last, match.index);
      if (inThink) currentThought += before;
      else visibleText += before;

      if (isClose) {
        if (inThink) closeThought();
        // Orphan closing tags are provider noise; swallow them instead of
        // leaking raw </think> into the answer and breaking Markdown structure.
      } else if (inThink) {
        currentThought += tag;
      } else {
        inThink = true;
        currentThought = "";
      }
      last = match.index + tag.length;
    }

    const tail = chunk.content.slice(last);
    if (inThink) currentThought += tail;
    else visibleText += tail;
  }

  if (inThink) {
    const trimmed = currentThought.trim();
    if (trimmed) thoughts.push(trimmed);
  }

  return {
    visibleText,
    thinkingText: thoughts.join("\n\n"),
    thinkingOpen: inThink,
  };
}

function parseThinkBlocks(raw: string): Segment[] {
  const extracted = extractThinking(raw);
  const segments: Segment[] = [];
  if (extracted.thinkingText || extracted.thinkingOpen) {
    segments.push({ kind: "think", content: extracted.thinkingText, open: extracted.thinkingOpen });
  }
  if (extracted.visibleText) segments.push({ kind: "text", content: extracted.visibleText });
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

function textFromReactNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromReactNode(node.props.children);
  return "";
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = languageFromCode(className, undefined);
  const code = textFromReactNode(children).replace(/\n$/, "");
  const lines = code.length > 0 ? code.split("\n") : [""];
  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <div className="md-code-header-left">
          <span className="md-code-dots" aria-hidden="true">
            <span className="md-code-dot md-code-dot-r" />
            <span className="md-code-dot md-code-dot-y" />
            <span className="md-code-dot md-code-dot-g" />
          </span>
          <span className="md-code-lang">{language}</span>
        </div>
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
      <div className="md-code-body">
        <div className="md-code-gutter" aria-hidden="true">
          {lines.map((_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <code className={`${className ?? ""} md-code-content`}>{children}</code>
      </div>
    </div>
  );
}

function classNameFromNode(node: unknown): string | undefined {
  const properties = (node as { properties?: { className?: unknown } } | null)?.properties;
  const className = properties?.className;
  if (typeof className === "string") return className;
  if (Array.isArray(className)) return className.filter((value) => typeof value === "string").join(" ");
  return undefined;
}

function languageFromCode(className: string | undefined, node: unknown): string {
  const classes = className ?? classNameFromNode(node) ?? "";
  return classes
    .split(/\s+/)
    .find((value) => value.startsWith("language-"))
    ?.replace("language-", "") ?? "text";
}

function isBlockCode(className: string | undefined, node: unknown, children: ReactNode): boolean {
  const classes = (className ?? classNameFromNode(node) ?? "").split(/\s+/);
  if (classes.some((value) => value === "hljs" || value.startsWith("language-"))) return true;
  const position = (node as {
    position?: { start?: { line?: number }; end?: { line?: number } };
  } | null)?.position;
  if (
    typeof position?.start?.line === "number"
    && typeof position?.end?.line === "number"
    && position.end.line > position.start.line
  ) {
    return true;
  }
  return textFromReactNode(children).includes("\n");
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
    if (!wasStreaming.current && streaming) setOpen(true);
    else if (wasStreaming.current && !streaming) setOpen(false);
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
        if (segment.kind === "think") {
          return (
            <ThinkBlock
              key={index}
              content={segment.content}
              streaming={Boolean(streaming && segment.open && index === segments.length - 1)}
            />
          );
        }
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
              code({ className, children, node, ...props }) {
                const language = languageFromCode(className, node);
                const code = textFromReactNode(children).replace(/\n$/, "");
                if (language.toLowerCase() === "mermaid") {
                  return <MermaidDiagram code={code} streaming={streaming} />;
                }
                return isBlockCode(className, node, children)
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
