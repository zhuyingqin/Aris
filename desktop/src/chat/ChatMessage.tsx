import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import type { ChatBlock, ChatTurn } from "../types";
import { fileOpen } from "../api/tauri";
import MarkdownContent, { ThinkBlock } from "./MarkdownContent";
import { CHAT_COPY } from "./i18n";
import { textFromTurn } from "./model";
import { useStore } from "../store";

const FILE_WRITE_TOOLS = new Set(["write_file", "append_file", "edit_file", "str_replace_based_edit_tool"]);

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

function parseOutput(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function diffFromCodexChanges(output: Record<string, unknown> | null): FileChange | null {
  const changes = output?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  for (const [path, rawChange] of Object.entries(changes as Record<string, unknown>)) {
    if (!path || !rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) continue;
    const change = rawChange as Record<string, unknown>;
    const type = typeof change.type === "string" ? change.type : "";
    if (type === "update") {
      const diff = typeof change.unified_diff === "string" ? change.unified_diff : "";
      if (diff) return { path, diff };
    }
    if (type === "add") {
      const content = typeof change.content === "string" ? change.content : "";
      return {
        path,
        diff: [`--- /dev/null`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n"),
      };
    }
    if (type === "delete") {
      const content = typeof change.content === "string" ? change.content : "";
      return {
        path,
        diff: [`--- ${path}`, `+++ /dev/null`, ...content.split("\n").map((line) => `-${line}`)].join("\n"),
      };
    }
  }
  return null;
}

export function diffFromTool(block: Extract<ChatBlock, { kind: "tool" }>): FileChange | null {
  if (!FILE_WRITE_TOOLS.has(block.name) || block.isError) return null;
  const output = parseOutput(block.output);
  const codexChange = diffFromCodexChanges(output);
  if (codexChange) return codexChange;

  const input = parseInput(block.input);
  const path = String(output?.filePath ?? input.path ?? input.file_path ?? input.target_file ?? "");
  if (!path) return null;
  if (block.name === "write_file") {
    const content = String(input.content ?? "");
    return {
      path,
      diff: [`--- /dev/null`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n"),
    };
  }
  if (block.name === "append_file") {
    const content = String(input.content ?? "");
    return {
      path,
      diff: [`--- ${path}`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n"),
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
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? copy.copied : copy.copy}
    </button>
  );
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function ToolProgressView({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const progress = block.progress;
  if (!progress || block.output !== undefined) return null;
  const hasTail = Boolean(progress.stdoutTail || progress.stderrTail);
  const timeout = progress.timeoutMs ? ` / ${formatElapsed(progress.timeoutMs)}` : "";
  return (
    <div className={`chat-tool-progress${progress.nearTimeout ? " near-timeout" : ""}`}>
      <div className="chat-tool-progress-line">
        <span>{progress.message || "Still running"}</span>
        <span>{formatElapsed(progress.elapsedMs)}{timeout}</span>
        {progress.pid != null && <span>PID {progress.pid}</span>}
      </div>
      {hasTail && (
        <div className="chat-tool-progress-tails">
          {progress.stdoutTail && (
            <pre className="md-view tool-detail tool-progress-tail">stdout: {progress.stdoutTail}</pre>
          )}
          {progress.stderrTail && (
            <pre className="md-view tool-detail tool-progress-tail">stderr: {progress.stderrTail}</pre>
          )}
        </div>
      )}
    </div>
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
      <ToolProgressView block={block} />
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

/**
 * Collapses a run of consecutive calls to the same tool (e.g. 77 × mail_move)
 * into one card with a `current/total` progress counter. Expanding it reveals
 * the individual calls, each still independently expandable.
 */
function ToolGroup({ blocks }: { blocks: Extract<ChatBlock, { kind: "tool" }>[] }) {
  const [open, setOpen] = useState(false);
  const total = blocks.length;
  const done = blocks.filter((b) => b.output !== undefined).length;
  const running = done < total;
  const anyError = blocks.some((b) => b.isError);
  const status = running ? "Running" : anyError ? "Failed" : "Succeeded";
  const className = running ? "tool-running" : anyError ? "tool-error" : "tool-done";
  // While running, point at the call in flight (done + 1); when finished, total.
  const current = running ? Math.min(done + 1, total) : total;
  const toggle = () => setOpen((value) => !value);
  return (
    <div className={`chat-tool chat-tool-group ${className}`}>
      <div
        className="chat-tool-header"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="tool-status-icon">{running ? "◌" : anyError ? "×" : "✓"}</span>
        <span className="tool-status-label">{status}</span>
        <span className="tool-name">{blocks[0].name}</span>
        <span className="tool-group-count" title={`${current} / ${total}`}>
          {current}/{total}
        </span>
        <span className="tool-collapse-btn">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="chat-tool-body chat-tool-group-body">
          {blocks.map((b, i) => (
            <ToolCall key={b.id ?? i} block={b} />
          ))}
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

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
}

/** Parses an `AskUserQuestion` tool input into a renderable question, or null
 *  if it isn't a well-formed question (the caller falls back to a tool card). */
function parseQuestionSpec(input: string): QuestionSpec | null {
  try {
    const value = JSON.parse(input) as Partial<QuestionSpec>;
    if (!value || typeof value.question !== "string" || !Array.isArray(value.options)) return null;
    const options = value.options.filter(
      (option): option is QuestionOption =>
        Boolean(option) && typeof (option as QuestionOption).label === "string",
    );
    if (options.length === 0) return null;
    return {
      question: value.question,
      header: typeof value.header === "string" && value.header.trim() ? value.header : undefined,
      options,
      multiSelect: value.multiSelect === true,
      // Free-form answers are allowed unless the model explicitly opts out.
      allowCustom: value.allowCustom !== false,
    };
  } catch {
    return null;
  }
}

/**
 * Renders an `AskUserQuestion` tool call as an interactive prompt: option
 * buttons (and, by default, a free-text answer) while the backend tool is
 * blocked waiting; once `output` arrives the user's answer is shown read-only.
 */
function QuestionCall({
  block,
  active,
  onQuestionRespond,
}: {
  block: Extract<ChatBlock, { kind: "tool" }>;
  active: boolean;
  onQuestionRespond: (toolUseId: string, answer: string) => void;
}) {
  const spec = useMemo(() => parseQuestionSpec(block.input), [block.input]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Not a usable question — show the raw tool call rather than an empty card.
  if (!spec) return <ToolCall block={block} />;

  const resolved = block.output !== undefined;
  // Interactive only while the turn is still running and waiting on this call;
  // a stopped/finished turn leaves the question unanswerable.
  const interactive = !resolved && active;
  const locked = !interactive || submitting || !block.id;
  const send = (answer: string) => {
    const text = answer.trim();
    if (locked || !block.id || !text) return;
    setSubmitting(true);
    onQuestionRespond(block.id, text);
  };
  const sendSelection = () => {
    const labels = [...selected].sort((a, b) => a - b).map((i) => spec.options[i].label);
    if (spec.allowCustom && custom.trim()) labels.push(custom.trim());
    send(labels.join(", "));
  };
  const toggle = (index: number) => {
    if (locked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const canSubmit = spec.multiSelect ? selected.size > 0 || custom.trim().length > 0 : custom.trim().length > 0;
  const answered = resolved && !block.isError;
  const statusClass = answered ? "tool-done" : interactive ? "tool-running" : "tool-error";
  const statusIcon = answered ? "✓" : interactive ? "?" : "!";
  const statusLabel = answered ? "Answered" : interactive ? "Awaiting your answer" : "Unanswered";

  return (
    <div className={`chat-tool chat-question-card ${statusClass}`}>
      <div className="chat-tool-header">
        <span className="tool-status-icon">{statusIcon}</span>
        <span className="tool-status-label">{statusLabel}</span>
        {spec.header && <span className="tool-name">{spec.header}</span>}
      </div>
      <div className="chat-question-body">
        <p className="chat-question-text">{spec.question}</p>
        {resolved ? (
          <div className="chat-question-answer">
            <span className="chat-question-answer-label">{block.isError ? "Not answered" : "You answered"}</span>
            <span className="chat-question-answer-value">{block.output}</span>
          </div>
        ) : !interactive ? (
          <p className="chat-question-stale">This question is no longer awaiting an answer.</p>
        ) : (
          <>
            <div className={`chat-question-options${spec.multiSelect ? " is-multi" : ""}`}>
              {spec.options.map((option, index) => (
                <button
                  key={index}
                  type="button"
                  className={`chat-question-option${selected.has(index) ? " selected" : ""}`}
                  disabled={locked}
                  onClick={() => (spec.multiSelect ? toggle(index) : send(option.label))}
                >
                  <span className="chat-question-option-label">{option.label}</span>
                  {option.description && (
                    <span className="chat-question-option-desc">{option.description}</span>
                  )}
                </button>
              ))}
            </div>
            {spec.allowCustom && (
              <input
                className="chat-question-custom"
                type="text"
                placeholder="Or type your own answer…"
                value={custom}
                disabled={locked}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (spec.multiSelect) sendSelection();
                    else send(custom);
                  }
                }}
              />
            )}
            {(spec.multiSelect || spec.allowCustom) && (
              <div className="chat-question-actions">
                <button
                  type="button"
                  disabled={locked || !canSubmit}
                  onClick={spec.multiSelect ? sendSelection : () => send(custom)}
                >
                  {submitting ? "Sending…" : "Submit"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function renderSingleBlock(
  block: ChatBlock,
  index: number,
  turn: ChatTurn,
  onPermissionRespond: (promptId: string, allow: boolean) => void,
  onQuestionRespond: (toolUseId: string, answer: string) => void,
) {
  if (block.kind === "text") {
    if (!block.text) return null;
    return turn.role === "assistant" ? (
      <MarkdownContent
        key={index}
        text={block.text}
        streaming={Boolean(turn.streaming && index === turn.blocks.length - 1)}
      />
    ) : (
      <div key={index} className="chat-text">
        {block.text}
      </div>
    );
  }
  if (block.kind === "thinking") {
    return block.thinking ? (
      <ThinkBlock
        key={index}
        content={block.thinking}
        streaming={Boolean(turn.streaming && index === turn.blocks.length - 1)}
      />
    ) : null;
  }
  if (block.kind === "notice") {
    return block.message ? (
      <div key={index} className="chat-context-notice">
        {block.message}
      </div>
    ) : null;
  }
  if (block.kind === "permission") {
    return <PermissionCall key={block.id} block={block} onPermissionRespond={onPermissionRespond} />;
  }
  // TodoWrite plans are surfaced by the floating workflow box, not inline.
  if (block.kind === "tool" && block.name === "TodoWrite") return null;
  if (block.kind === "tool" && block.name === "AskUserQuestion") {
    return (
      <QuestionCall
        key={block.id ?? index}
        block={block}
        active={Boolean(turn.streaming)}
        onQuestionRespond={onQuestionRespond}
      />
    );
  }
  return <ToolCall key={block.id ?? index} block={block} />;
}

function renderAssistantTextRun(blocks: ChatBlock[], start: number, end: number, turn: ChatTurn) {
  const text = blocks
    .filter((block): block is Extract<ChatBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("");
  const thinking = blocks
    .filter((block): block is Extract<ChatBlock, { kind: "thinking" }> => block.kind === "thinking")
    .map((block) => block.thinking.trim())
    .filter(Boolean)
    .join("\n\n");
  const last = blocks[blocks.length - 1];
  const isTailRun = end === turn.blocks.length;
  return (
    <Fragment key={`assistant-text-run-${start}`}>
      {thinking && (
        <ThinkBlock
          content={thinking}
          streaming={Boolean(turn.streaming && isTailRun && last?.kind === "thinking")}
        />
      )}
      {text.trim() && (
        <MarkdownContent
          text={text}
          streaming={Boolean(turn.streaming && isTailRun && last?.kind === "text")}
        />
      )}
    </Fragment>
  );
}

/**
 * Renders a turn's blocks, collapsing runs of ≥2 consecutive calls to the same
 * tool into a single {@link ToolGroup}. Other blocks render individually.
 */
function renderBlocks(
  turn: ChatTurn,
  onPermissionRespond: (promptId: string, allow: boolean) => void,
  onQuestionRespond: (toolUseId: string, answer: string) => void,
) {
  const blocks = turn.blocks;
  const out: ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (turn.role === "assistant" && (block.kind === "text" || block.kind === "thinking")) {
      let j = i + 1;
      while (j < blocks.length && (blocks[j].kind === "text" || blocks[j].kind === "thinking")) {
        j += 1;
      }
      out.push(renderAssistantTextRun(blocks.slice(i, j), i, j, turn));
      i = j;
      continue;
    }
    // AskUserQuestion is interactive and rendered individually, never collapsed.
    if (block.kind === "tool" && block.name !== "TodoWrite" && block.name !== "AskUserQuestion") {
      let j = i + 1;
      while (j < blocks.length) {
        const next = blocks[j];
        if (next.kind !== "tool" || next.name !== block.name) break;
        j += 1;
      }
      if (j - i > 1) {
        const run = blocks.slice(i, j) as Extract<ChatBlock, { kind: "tool" }>[];
        out.push(<ToolGroup key={block.id ?? `group-${i}`} blocks={run} />);
        i = j;
        continue;
      }
    }
    out.push(renderSingleBlock(block, i, turn, onPermissionRespond, onQuestionRespond));
    i += 1;
  }
  return out;
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
  onQuestionRespond?: (toolUseId: string, answer: string) => void;
}

function ChatMessage({
  turn,
  canRetry,
  onEdit,
  onRetry,
  onContinue,
  onPermissionRespond = () => undefined,
  onQuestionRespond = () => undefined,
}: Props) {
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  const text = textFromTurn(turn);
  const hasContent = hasRenderableContent(turn);
  return (
    <article className={`chat-turn chat-${turn.role}${turn.error ? " chat-turn-error" : ""}`}>
      {turn.role === "user" && turn.attachments && turn.attachments.length > 0 && (
        <div className="chat-message-attachments">
          {turn.attachments.map((attachment) => <span key={attachment.id}>{attachment.kind === "image" ? copy.image : copy.file}: {attachment.name}</span>)}
        </div>
      )}
      {renderBlocks(turn, onPermissionRespond, onQuestionRespond)}
      {!turn.streaming && !turn.error && !turn.stopped && !hasContent && turn.role === "assistant" && (
        <div className="chat-empty-response">{copy.emptyResponse}</div>
      )}
      {!turn.streaming && !turn.error && turn.stopped && turn.role === "assistant" && (
        <div className="chat-stopped-card">
          <strong>{copy.responseStopped}</strong>
          <span>{copy.stoppedByUser}</span>
        </div>
      )}
      {turn.streaming && <span className="chat-inline-cursor">▌</span>}
      {turn.error && (
        <div className="chat-error-card">
          <strong>{copy.responseFailed}</strong>
          <span>{turn.error}</span>
          <button onClick={() => onRetry(turn)}>{copy.retry}</button>
        </div>
      )}
      <div className="chat-message-actions">
        {text && <CopyButton text={text} />}
        {turn.role === "user" && !turn.streaming && <button onClick={() => onEdit(turn)}>{copy.editAndResend}</button>}
        {turn.role === "assistant" && canRetry && !turn.streaming && !turn.error && <button onClick={() => onRetry(turn)}>{copy.retry}</button>}
        {turn.role === "assistant" && turn.stopped && <button onClick={onContinue}>{copy.continue}</button>}
      </div>
    </article>
  );
}

export default memo(ChatMessage);
