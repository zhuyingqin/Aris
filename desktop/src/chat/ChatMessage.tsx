import { memo, useMemo, useState } from "react";
import type { ChatBlock, ChatTurn } from "../types";
import { fileOpen } from "../api/tauri";
import MarkdownContent, { ThinkBlock } from "./MarkdownContent";
import { textFromTurn } from "./model";
import { useStore } from "../store";

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "str_replace_based_edit_tool"]);

interface FileChange {
  path: string;
  diff: string;
}

interface StudioLink {
  id: string;
  title: string;
  href: string;
}

function studioLinksFromTool(block: Extract<ChatBlock, { kind: "tool" }>): StudioLink[] {
  if (block.name !== "StudioLibraryUpsert" || block.isError || !block.output) return [];
  try {
    const output = JSON.parse(block.output) as { studioLinks?: unknown };
    if (!Array.isArray(output.studioLinks)) return [];
    return output.studioLinks.filter((link): link is StudioLink => {
      if (!link || typeof link !== "object") return false;
      const value = link as Partial<StudioLink>;
      return typeof value.id === "string"
        && typeof value.title === "string"
        && typeof value.href === "string";
    });
  } catch {
    return [];
  }
}

function parseInput(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function diffFromTool(block: Extract<ChatBlock, { kind: "tool" }>): FileChange | null {
  if (!FILE_WRITE_TOOLS.has(block.name) || block.isError) return null;
  const input = parseInput(block.input);
  const path = String(input.path ?? input.file_path ?? input.target_file ?? "");
  if (!path) return null;
  if (block.name === "write_file") {
    const content = String(input.content ?? "");
    return {
      path,
      diff: [`--- /dev/null`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n"),
    };
  }
  const before = String(input.old_string ?? input.old_str ?? input.old_text ?? "");
  const after = String(input.new_string ?? input.new_str ?? input.new_text ?? "");
  return {
    path,
    diff: [
      `--- ${path}`,
      `+++ ${path}`,
      ...before.split("\n").map((line) => `-${line}`),
      ...after.split("\n").map((line) => `+${line}`),
    ].join("\n"),
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ToolCall({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const change = useMemo(() => diffFromTool(block), [block]);
  const studioLinks = useMemo(() => studioLinksFromTool(block), [block]);
  const setTab = useStore((state) => state.setTab);
  const setPendingStudioArtifactId = useStore((state) => state.setPendingStudioArtifactId);
  const running = block.output === undefined;
  const status = running ? "Running" : block.isError ? "Failed" : change ? "Modified file" : "Succeeded";
  const className = running ? "tool-running" : block.isError ? "tool-error" : change ? "tool-change" : "tool-done";
  const toggle = () => {
    if (!running) setOpen((value) => !value);
  };
  return (
    <div className={`chat-tool ${className}`}>
      <div
        className="chat-tool-header"
        role="button"
        tabIndex={running ? -1 : 0}
        aria-disabled={running}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="tool-status-icon">{running ? "◌" : block.isError ? "×" : change ? "±" : "✓"}</span>
        <span className="tool-status-label">{status}</span>
        {change ? (
          <button
            type="button"
            className="tool-name tool-file-link"
            title="Open generated file"
            onClick={(event) => {
              event.stopPropagation();
              void fileOpen(change.path).catch((error) => console.error("Unable to open file", error));
            }}
          >
            {change.path}
          </button>
        ) : (
          <span className="tool-name">{block.name}</span>
        )}
        {!running && <span className="tool-collapse-btn">{open ? "▾" : "▸"}</span>}
      </div>
      {studioLinks.length > 0 && (
        <div className="chat-tool-studio-links">
          {studioLinks.map((link) => (
            <button
              key={link.id}
              type="button"
              onClick={() => {
                setPendingStudioArtifactId(link.id);
                setTab("studio");
              }}
            >
              Open {link.title} in Studio
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="chat-tool-body">
          {change ? (
            <pre className="tool-diff">{change.diff}</pre>
          ) : (
            <>
              {block.input && block.input !== "{}" && <pre className="md-view tool-detail">{block.input}</pre>}
              {block.output !== undefined && <pre className="md-view tool-detail tool-output">{block.output}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PermissionCall({
  block,
  onPermissionRespond,
}: {
  block: Extract<ChatBlock, { kind: "permission" }>;
  onPermissionRespond: (promptId: string, allow: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = !block.status || block.status === "pending";
  const status = block.status === "allowed" ? "Continued" : block.status === "skipped" ? "Skipped" : "Waiting";
  return (
    <div className={`chat-tool chat-permission-card ${pending ? "tool-running" : block.status === "skipped" ? "tool-error" : "tool-done"}`}>
      <div className="chat-tool-header">
        <span className="tool-status-icon">{pending ? "?" : block.status === "skipped" ? "!" : "✓"}</span>
        <span className="tool-status-label">{status}</span>
        <span className="tool-name">{block.toolName}</span>
        <span className="tool-status-label">{block.currentMode} → {block.requiredMode}</span>
      </div>
      <div className="chat-permission-actions">
        <button type="button" disabled={!pending} onClick={() => onPermissionRespond(block.id, true)}>
          Continue
        </button>
        <button type="button" disabled={!pending} onClick={() => onPermissionRespond(block.id, false)}>
          Skip
        </button>
        {block.input && (
          <button type="button" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide input" : "Show input"}
          </button>
        )}
      </div>
      {open && block.input && (
        <div className="chat-tool-body">
          <pre className="md-view tool-detail">{block.input}</pre>
        </div>
      )}
    </div>
  );
}

function hasRenderableContent(turn: ChatTurn): boolean {
  return turn.blocks.some((block) => {
    if (block.kind === "text") return Boolean(block.text.trim());
    if (block.kind === "thinking") return Boolean(block.thinking.trim());
    return true;
  });
}

interface Props {
  turn: ChatTurn;
  canRetry: boolean;
  onEdit: (turn: ChatTurn) => void;
  onRetry: (turn: ChatTurn) => void;
  onContinue: () => void;
  onPermissionRespond?: (promptId: string, allow: boolean) => void;
}

function ChatMessage({ turn, canRetry, onEdit, onRetry, onContinue, onPermissionRespond = () => undefined }: Props) {
  const text = textFromTurn(turn);
  const hasContent = hasRenderableContent(turn);
  return (
    <article className={`chat-turn chat-${turn.role}${turn.error ? " chat-turn-error" : ""}`}>
      {turn.role === "user" && turn.attachments && turn.attachments.length > 0 && (
        <div className="chat-message-attachments">
          {turn.attachments.map((attachment) => <span key={attachment.id}>{attachment.kind === "image" ? "Image" : "File"}: {attachment.name}</span>)}
        </div>
      )}
      {turn.blocks.map((block, index) => {
        if (block.kind === "text") {
          if (!block.text) return null;
          return turn.role === "assistant"
            ? <MarkdownContent key={index} text={block.text} streaming={Boolean(turn.streaming && index === turn.blocks.length - 1)} />
            : <div key={index} className="chat-text">{block.text}</div>;
        }
        if (block.kind === "thinking") {
          return block.thinking
            ? <ThinkBlock key={index} content={block.thinking} streaming={Boolean(turn.streaming && index === turn.blocks.length - 1)} />
            : null;
        }
        if (block.kind === "permission") {
          return <PermissionCall key={block.id} block={block} onPermissionRespond={onPermissionRespond} />;
        }
        // TodoWrite plans are surfaced by the floating workflow box, not inline.
        if (block.kind === "tool" && block.name === "TodoWrite") return null;
        return <ToolCall key={block.id ?? index} block={block} />;
      })}
      {!turn.streaming && !turn.error && !hasContent && turn.role === "assistant" && (
        <div className="chat-empty-response">Model returned an empty response.</div>
      )}
      {turn.streaming && <span className="chat-inline-cursor">▌</span>}
      {turn.error && (
        <div className="chat-error-card">
          <strong>Response failed</strong>
          <span>{turn.error}</span>
          <button onClick={() => onRetry(turn)}>Retry</button>
        </div>
      )}
      <div className="chat-message-actions">
        {text && <CopyButton text={text} />}
        {turn.role === "user" && !turn.streaming && <button onClick={() => onEdit(turn)}>Edit and resend</button>}
        {turn.role === "assistant" && canRetry && !turn.streaming && !turn.error && <button onClick={() => onRetry(turn)}>Retry</button>}
        {turn.role === "assistant" && turn.stopped && <button onClick={onContinue}>Continue</button>}
      </div>
    </article>
  );
}

export default memo(ChatMessage);
