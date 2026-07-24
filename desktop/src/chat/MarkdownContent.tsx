import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { fileOpen } from "../api/tauri";
import { workspaceFileOpenTarget } from "../lab/labEditorCore";
import { SvgIcon } from "../SvgIcon";
import { isExplicitLocalFileHref, normalizeLocalFileHref } from "./localFileLinks";
import { useStore } from "../store";
import ChatImagePreview, { isDirectImageSource, isPreviewableImagePath } from "./ChatImagePreview";
import MermaidDiagram from "./MermaidDiagram";

const MAX_MARKDOWN_RENDER_CHARS = 80_000;
const LARGE_MARKDOWN_HEAD_CHARS = 48_000;
const LARGE_MARKDOWN_TAIL_CHARS = 16_000;
// Above this size we render full Markdown (structure, tables, math) but drop
// syntax highlighting. highlight.js runs synchronously inside the react-markdown
// pipeline and is the dominant blocking cost when opening a large conversation
// (several big blocks in the initial viewport get highlighted at once). Skipping
// it keeps code readable — just uncolored — and removes the open-time freeze.
const HIGHLIGHT_MAX_CHARS = 12_000;

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

const DENSE_PARAGRAPH_MIN_CHARS = 360;
const DENSE_PARAGRAPH_TARGET_CHARS = 260;

function charCount(text: string): number {
  return Array.from(text).length;
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

function isMarkdownStructureBlock(block: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s+|\d+[.)]\s+|>\s|\|)/.test(block)
    || /^\s*(<\w|<\/\w|```|~~~)/.test(block);
}

function splitLongReadableParagraph(text: string): string {
  if (charCount(text) <= DENSE_PARAGRAPH_MIN_CHARS) return text;
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/g);
  if (!sentences || sentences.length < 3) return text;

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = sentence.trimStart();
    if (current && charCount(current + next) > DENSE_PARAGRAPH_TARGET_CHARS) {
      chunks.push(current.trim());
      current = next;
    } else {
      current += next;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 1 ? chunks.join("\n\n") : text;
}

function formatDenseParagraphBlock(block: string): string {
  if (charCount(block.trim()) < DENSE_PARAGRAPH_MIN_CHARS || isMarkdownStructureBlock(block)) {
    return block;
  }

  const prefix = block.match(/^\s*/)?.[0] ?? "";
  const suffix = block.match(/\s*$/)?.[0] ?? "";
  const transitionPattern =
    "(?:第[一二三四五六七八九十\\d]+步|首先|其次|然后|最后|另外|不过|因此|所以|总体|总之|核心|关键|具体|效果|实验|消融|注意|换句话说|简单说|也就是说|只训|严格冻结)";
  const withBreaks = block
    .trim()
    .replace(new RegExp(`([。！？!?；;])\\s*(?=${transitionPattern})`, "g"), "$1\n\n");
  const paragraphs = withBreaks
    .split(/\n{2,}/)
    .map((paragraph) => splitLongReadableParagraph(paragraph.trim()))
    .filter(Boolean);
  return `${prefix}${paragraphs.join("\n\n")}${suffix}`;
}

function formatDenseMarkdown(raw: string): string {
  return splitMarkdownFences(raw)
    .map((chunk) => {
      if (chunk.kind === "code") return chunk.content;
      return chunk.content
        .split(/(\n{2,})/)
        .map((part) => (/^\n{2,}$/.test(part) ? part : formatDenseParagraphBlock(part)))
        .join("");
    })
    .join("");
}

function normalizeMathDelimiters(raw: string): string {
  return splitMarkdownFences(raw)
    .map((chunk) => {
      if (chunk.kind === "code") return chunk.content;
      return chunk.content
        .replace(/\\\[([\s\S]+?)\\\]/g, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
        .replace(/(^|\n)[ \t]*\$\$([^\n][\s\S]*?[^\n])\$\$[ \t]*(?=\n|$)/g, (_match, prefix: string, formula: string) => `${prefix}$$\n${formula.trim()}\n$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_match, formula: string) => `$${formula}$`);
    })
    .join("");
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
  return normalizeLocalFileHref(href);
}

function markdownUrlTransform(url: string, key: string): string {
  if (key === "src" && /^(data:image\/|blob:)/i.test(url)) return url;
  if (key === "href" && /^(data:image\/|blob:)/i.test(url) && isPreviewableImagePath(url)) return url;
  if (key === "href" && isExplicitLocalFileHref(url)) return url;
  return defaultUrlTransform(url);
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
  const setPendingLabFilePath = useStore((state) => state.setPendingLabFilePath);
  const setPendingTypesetFilePath = useStore((state) => state.setPendingTypesetFilePath);
  const setError = useStore((state) => state.setError);
  const language = useStore((state) => state.language);
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
  if (href && isPreviewableImagePath(href)) {
    const title = textFromReactNode(children) || decodeLocalHref(href);
    return (
      <ChatImagePreview
        src={href}
        alt={title}
        title={title}
        openPath={isDirectImageSource(href) ? undefined : decodeLocalHref(href)}
        className="chat-markdown-image-link"
      />
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
        const path = decodeLocalHref(href);
        const target = workspaceFileOpenTarget(path);
        if (target === "code") {
          setPendingLabFilePath(path);
          setTab("lab");
          return;
        }
        if (target === "latex" || target === "pdf") {
          setPendingTypesetFilePath(path);
          setTab("typeset");
          return;
        }
        void fileOpen(path).catch((error) => {
          setError(`${language === "cn" ? "无法打开文件" : "Unable to open file"}: ${String(error)}`);
        });
      }}
    >
      {children}<SvgIcon name="externalLink" size={12} className="md-local-link-icon" />
    </a>
  );
}

export const ThinkBlock = memo(function ThinkBlock({
  content,
  streaming = false,
  revealWhileTurnStreaming = false,
}: {
  content: string;
  streaming?: boolean;
  revealWhileTurnStreaming?: boolean;
}) {
  const autoOpen = streaming || revealWhileTurnStreaming;
  const [open, setOpen] = useState(autoOpen);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startRef = useRef<number | null>(null);
  const wasAutoOpen = useRef(autoOpen);
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

  // A provider can finish thinking and begin answer text inside one batched
  // React update. Keep the newest thinking phase revealed for the rest of the
  // active turn, then collapse it when the whole turn finishes.
  useEffect(() => {
    if (!wasAutoOpen.current && autoOpen) setOpen(true);
    else if (wasAutoOpen.current && !autoOpen) setOpen(false);
    wasAutoOpen.current = autoOpen;
  }, [autoOpen]);

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
        <span className="md-think-icon"><SvgIcon name={open ? "chevronDown" : "chevronRight"} size={12} /></span>
        {streaming && <span className="md-think-spinner" aria-hidden="true" />}
        <span className="md-think-label">{label}</span>
        {!streaming && !open && content && (
          <span className="md-think-preview">{preview}{content.length > 80 ? "..." : ""}</span>
        )}
      </button>
      {open && (
        <div className="md-think-body" ref={bodyRef}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
            urlTransform={markdownUrlTransform}
          >
            {normalizeMathDelimiters(content)}
          </ReactMarkdown>
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
        // Drop highlight.js on large blocks — it is the main synchronous cost
        // when a big conversation mounts its recent turns. Small blocks (the
        // common case) keep full syntax highlighting.
        const rehypePlugins: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] =
          segment.content.length > HIGHLIGHT_MAX_CHARS
            ? [[rehypeKatex, { throwOnError: false }]]
            : [[rehypeKatex, { throwOnError: false }], rehypeHighlight];
        return (
          <ReactMarkdown
            key={index}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={rehypePlugins}
            urlTransform={markdownUrlTransform}
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
              img({ src, alt, title }) {
                if (!src) return null;
                return (
                  <ChatImagePreview
                    src={src}
                    alt={alt ?? title ?? ""}
                    title={title ?? alt ?? src}
                    openPath={isDirectImageSource(src) ? undefined : decodeLocalHref(src)}
                    className="chat-markdown-image"
                  />
                );
              },
            }}
          >
            {normalizeMathDelimiters(formatDenseMarkdown(segment.content))}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}

export default memo(MarkdownContent);
