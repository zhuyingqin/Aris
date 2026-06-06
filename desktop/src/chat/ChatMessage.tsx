import { memo, useMemo, useState } from "react";
import type { ChatBlock, ChatTurn } from "../types";
import MarkdownContent, { ThinkBlock } from "./MarkdownContent";
import { textFromTurn } from "./model";

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "str_replace_based_edit_tool"]);

interface FileChange {
  path: string;
  diff: string;
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
  const running = block.output === undefined;
  const status = running ? "Running" : block.isError ? "Failed" : change ? "Modified file" : "Succeeded";
  const className = running ? "tool-running" : block.isError ? "tool-error" : change ? "tool-change" : "tool-done";
  return (
    <div className={`chat-tool ${className}`}>
      <button className="chat-tool-header" onClick={() => setOpen((value) => !value)} disabled={running}>
        <span className="tool-status-icon">{running ? "◌" : block.isError ? "×" : change ? "±" : "✓"}</span>
        <span className="tool-status-label">{status}</span>
        <span className="tool-name">{change?.path ?? block.name}</span>
        {!running && <span className="tool-collapse-btn">{open ? "▾" : "▸"}</span>}
      </button>
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

interface Props {
  turn: ChatTurn;
  canRetry: boolean;
  onEdit: (turn: ChatTurn) => void;
  onRetry: (turn: ChatTurn) => void;
  onContinue: () => void;
}

function ChatMessage({ turn, canRetry, onEdit, onRetry, onContinue }: Props) {
  const text = textFromTurn(turn);
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
        return <ToolCall key={block.id ?? index} block={block} />;
      })}
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
