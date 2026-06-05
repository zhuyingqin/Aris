import { useCallback, useEffect, useRef, useState } from "react";
import MarkdownContent from "./MarkdownContent";
import {
  chatCancel,
  chatReset,
  chatSend,
  chatStatus,
  fileRead,
  fileSearch,
  isTauri,
  onChatDelta,
  onChatDone,
  onChatTool,
  onChatToolResult,
  skillsList,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatBlock, ChatStatus, ChatTurn, SkillMeta } from "../types";

// ── Session storage ────────────────────────────────────────────────────────────

interface ChatSession {
  id: string;
  title: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

const SESSIONS_KEY = "aris-chat-sessions";
const CURRENT_KEY = "aris-chat-current-id";

/** Migrate legacy turn format ({text,tools}) → blocks[] */
function migrateTurn(raw: unknown): ChatTurn {
  const t = raw as Record<string, unknown>;
  if (Array.isArray(t.blocks)) {
    return { role: t.role as "user" | "assistant", blocks: t.blocks as ChatBlock[], streaming: false };
  }
  // Legacy: text + tools
  const blocks: ChatBlock[] = [];
  if (t.text && typeof t.text === "string" && t.text.trim()) {
    blocks.push({ kind: "text", text: t.text as string });
  }
  const tools = Array.isArray(t.tools) ? t.tools : [];
  for (const tool of tools as Record<string, unknown>[]) {
    blocks.push({
      kind: "tool",
      id: tool.id as string | undefined,
      name: tool.name as string,
      input: tool.input as string,
      output: tool.output as string | undefined,
      isError: tool.isError as boolean | undefined,
    });
  }
  return { role: t.role as "user" | "assistant", blocks, streaming: false };
}

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSession[];
    return parsed.map((s) => ({ ...s, turns: s.turns.map(migrateTurn) }));
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)); } catch {}
}

function makeSession(): ChatSession {
  return { id: `chat-${Date.now()}`, title: "New chat", turns: [], createdAt: Date.now(), updatedAt: Date.now() };
}

function titleFromTurns(turns: ChatTurn[]): string {
  const first = turns.find((t) => t.role === "user");
  if (!first) return "New chat";
  const text = first.blocks.find((b) => b.kind === "text");
  if (!text || text.kind !== "text") return "New chat";
  return text.text.slice(0, 48) + (text.text.length > 48 ? "…" : "");
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ── Block helpers ─────────────────────────────────────────────────────────────

/** Append a text delta to last text block, or push a new one. */
function appendTextDelta(blocks: ChatBlock[], delta: string): ChatBlock[] {
  const copy = blocks.slice();
  const last = copy[copy.length - 1];
  if (last && last.kind === "text") {
    copy[copy.length - 1] = { kind: "text", text: last.text + delta };
  } else {
    copy.push({ kind: "text", text: delta });
  }
  return copy;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Chat() {
  const setTab = useStore((s) => s.setTab);

  // Sessions
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions);
  const [currentId, setCurrentId] = useState<string>(() => {
    const saved = localStorage.getItem(CURRENT_KEY);
    const all = loadSessions();
    if (saved && all.find((s) => s.id === saved)) return saved;
    return all.length > 0 ? all[all.length - 1].id : "";
  });

  const currentSession = sessions.find((s) => s.id === currentId) ?? null;
  const turns = currentSession?.turns ?? [];

  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Skills picker
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  // Picker visibility is derived from `pickerMode`; this setter is kept as a
  // no-op reset hook at session boundaries (the boolean itself is unused).
  const [, setShowPicker] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [pickerIdx, setPickerIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerScrollRef = useRef<HTMLDivElement>(null);

  // @ file picker
  type PickerMode = "skill" | "file" | null;
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const fileScrollRef = useRef<HTMLDivElement>(null);

  // Tool collapse: key = "sessionId-turnIdx-blockIdx", false = expanded
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => { saveSessions(sessions); }, [sessions]);
  useEffect(() => { if (currentId) localStorage.setItem(CURRENT_KEY, currentId); }, [currentId]);

  // Scroll active skill item into view when keyboard navigating
  useEffect(() => {
    const container = pickerScrollRef.current;
    if (!container) return;
    const active = container.querySelector(".skill-picker-item.active") as HTMLElement | null;
    active?.scrollIntoView({ block: "nearest" });
  }, [pickerIdx]);

  // Scroll active file item into view
  useEffect(() => {
    const container = fileScrollRef.current;
    if (!container) return;
    const active = container.querySelector(".file-picker-item.active") as HTMLElement | null;
    active?.scrollIntoView({ block: "nearest" });
  }, [fileIdx]);

  // Search files when @query changes — only search when user has typed something
  useEffect(() => {
    if (pickerMode !== "file") return;
    if (!isTauri()) return;
    if (!fileQuery.trim()) {
      setFileResults([]);
      return;
    }
    const pattern = `**/*${fileQuery}*`;
    fileSearch(pattern)
      .then((r) => { setFileResults(r); setFileIdx(0); })
      .catch(() => setFileResults([]));
  }, [fileQuery, pickerMode]);

  useEffect(() => {
    if (!isTauri()) return;
    skillsList().then(setSkills).catch(() => undefined);
  }, []);

  // ── Session helpers ──────────────────────────────────────────────────────────

  const patchCurrentTurns = (fn: (turns: ChatTurn[]) => ChatTurn[]) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== currentId) return s;
        const newTurns = fn(s.turns);
        return { ...s, turns: newTurns, updatedAt: Date.now(), title: titleFromTurns(newTurns) };
      }),
    );
  };

  const patchLastAssistant = (fn: (t: ChatTurn) => ChatTurn) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== currentId) return s;
        const copy = s.turns.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant") { copy[i] = fn(copy[i]); break; }
        }
        return { ...s, turns: copy, updatedAt: Date.now() };
      }),
    );
  };

  const openSession = (id: string) => { setCurrentId(id); setInput(""); setShowPicker(false); };

  const newSession = async () => {
    await chatReset().catch(() => undefined);
    const s = makeSession();
    setSessions((prev) => [...prev, s]);
    setCurrentId(s.id);
    setInput("");
    setShowPicker(false);
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (currentId === id) {
        if (next.length > 0) setCurrentId(next[next.length - 1].id);
        else { const fresh = makeSession(); setCurrentId(fresh.id); return [fresh]; }
      }
      return next;
    });
  };

  // Ensure there's always a current session
  useEffect(() => {
    if (!currentId || !sessions.find((s) => s.id === currentId)) {
      if (sessions.length > 0) {
        setCurrentId(sessions[sessions.length - 1].id);
      } else {
        const s = makeSession();
        setSessions([s]);
        setCurrentId(s.id);
      }
    }
  }, [currentId, sessions]);

  // ── Tauri event listeners ────────────────────────────────────────────────────

  useEffect(() => {
    if (!isTauri()) return;
    chatStatus().then(setStatus).catch((e) => setStatus({ ready: false, message: String(e) }));

    const unlisteners = [
      // Text delta → append to last text block (or create one) in chronological order
      onChatDelta((text) =>
        patchLastAssistant((t) => ({ ...t, blocks: appendTextDelta(t.blocks, text) })),
      ),
      // New tool call → push a tool block after any existing blocks
      onChatTool((tool) =>
        patchLastAssistant((t) => ({
          ...t,
          blocks: [
            ...t.blocks,
            { kind: "tool", id: tool.id, name: tool.name, input: tool.input },
          ],
        })),
      ),
      // Tool result → find matching pending tool block and fill in output
      onChatToolResult((res) =>
        patchLastAssistant((t) => {
          const blocks = t.blocks.slice();
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.kind === "tool" && b.output === undefined && b.name === res.name) {
              blocks[i] = { ...b, output: res.output, isError: res.isError };
              break;
            }
          }
          return { ...t, blocks };
        }),
      ),
      onChatDone(() => patchLastAssistant((t) => ({ ...t, streaming: false }))),
    ];

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => undefined));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  // ── Skills picker ────────────────────────────────────────────────────────────

  const filteredSkills = skills.filter(
    (s) =>
      !skillFilter ||
      s.name.toLowerCase().includes(skillFilter.toLowerCase()) ||
      (s.description ?? "").toLowerCase().includes(skillFilter.toLowerCase()),
  );
  const showSkillPicker = pickerMode === "skill" && filteredSkills.length > 0;
  const showFilePicker = pickerMode === "file";

  const insertSkill = (skillName: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    const match = before.match(/(^|\s)(\/\w*)$/);
    if (match) {
      const start = before.lastIndexOf(match[2]);
      setInput(input.slice(0, start) + `/${skillName} ` + after);
    }
    setPickerMode(null);
    el.focus();
  };

  const insertFile = useCallback(async (path: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    const match = before.match(/(^|\s)@(\S*)$/);
    const start = match ? before.lastIndexOf(match[0].trimStart()) : cursor;

    // Read file content and inline as a fenced block
    let content = "";
    try { content = await fileRead(path, 300); } catch { content = "(unreadable)"; }
    const ext = path.split(".").pop() ?? "";
    const fence = `@${path}\n\`\`\`${ext}\n${content}\n\`\`\``;
    setInput(input.slice(0, start) + fence + " " + after);
    setPickerMode(null);
    el.focus();
  }, [input]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);

    const slashMatch = before.match(/(^|\s)\/(\w*)$/);
    const atMatch = before.match(/(^|\s)@(\S*)$/);

    if (slashMatch) {
      setSkillFilter(slashMatch[2]);
      setPickerMode("skill");
      setPickerIdx(0);
    } else if (atMatch) {
      setFileQuery(atMatch[2]);
      setPickerMode("file");
      setFileIdx(0);
    } else {
      setPickerMode(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerMode === "skill") {
      if (e.key === "ArrowDown") { e.preventDefault(); setPickerIdx((i) => Math.min(i + 1, filteredSkills.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPickerIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (filteredSkills[pickerIdx]) insertSkill(filteredSkills[pickerIdx].name); return; }
      if (e.key === "Escape") { setPickerMode(null); return; }
    }
    if (pickerMode === "file") {
      if (e.key === "ArrowDown") { e.preventDefault(); setFileIdx((i) => Math.min(i + 1, fileResults.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setFileIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (fileResults[fileIdx]) void insertFile(fileResults[fileIdx]); return; }
      if (e.key === "Escape") { setPickerMode(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  // ── Send ─────────────────────────────────────────────────────────────────────

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setShowPicker(false);
    setBusy(true);

    patchCurrentTurns((prev) => [
      ...prev,
      { role: "user", blocks: [{ kind: "text", text }] },
      { role: "assistant", blocks: [], streaming: true },
    ]);

    try {
      const reply = await chatSend(text);
      patchLastAssistant((t) => {
        const hasText = t.blocks.some((b) => b.kind === "text" && b.text);
        const blocks = hasText
          ? t.blocks
          : reply
            ? [...t.blocks, { kind: "text" as const, text: reply }]
            : t.blocks;
        return { ...t, blocks, streaming: false };
      });
    } catch (e) {
      patchLastAssistant((t) => ({
        ...t,
        blocks: [...t.blocks, { kind: "text" as const, text: `⚠ ${e}` }],
        streaming: false,
      }));
    } finally {
      setBusy(false);
    }
  };

  const toggleTool = (key: string) =>
    setCollapsed((c) => ({ ...c, [key]: c[key] !== false ? false : true }));

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">Chat needs the Tauri backend.</div>
      </div>
    );
  }

  return (
    <div className="chat-root">
      {/* ── History sidebar ── */}
      <div className="chat-sidebar">
        <div className="chat-sidebar-head">
          <span>Chats</span>
          <button className="chat-new-btn" onClick={newSession} title="New chat">＋</button>
        </div>
        <div className="chat-session-list">
          {sessions.length === 0 && <div className="chat-session-empty">No history yet</div>}
          {[...sessions].reverse().map((s) => (
            <div
              key={s.id}
              className={`chat-session-item${s.id === currentId ? " active" : ""}`}
              onClick={() => openSession(s.id)}
            >
              <div className="chat-session-title">{s.title}</div>
              <div className="chat-session-meta">
                <span>{fmtDate(s.updatedAt)}</span>
                <span className="chat-session-count">
                  {s.turns.filter((t) => t.role === "user").length} msgs
                </span>
              </div>
              <button className="chat-session-del" onClick={(e) => deleteSession(s.id, e)} title="Delete">×</button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main chat pane ── */}
      <div className="chat">
        <div className="chat-head">
          <div>
            {status?.ready ? (
              <span className="hint">
                <b>{status.model}</b>
                <span style={{ margin: "0 5px", opacity: 0.4 }}>·</span>
                {status.provider}
              </span>
            ) : (
              <span className="err" style={{ padding: 0 }}>
                {status?.message ?? "checking…"}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {!status?.ready && <button onClick={() => setTab("settings")}>Settings</button>}
            <button onClick={newSession} disabled={busy}>New chat</button>
          </div>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {turns.length === 0 ? (
            <div className="chat-welcome">
              <div className="chat-welcome-icon">🌙</div>
              <div className="chat-welcome-title">ARIS</div>
              <div className="chat-welcome-sub">
                Ask anything · run workflows · explore research
                <br />
                Type <kbd>/</kbd> to pick a skill
              </div>
            </div>
          ) : (
            turns.map((t, i) => (
              <ChatBubble
                key={i}
                turn={t}
                turnKey={`${currentId}-${i}`}
                collapsed={collapsed}
                onToggleTool={toggleTool}
              />
            ))
          )}
        </div>

        <div className="chat-input-wrap">
          {showSkillPicker && (
            <div className="skill-picker">
              <div className="skill-picker-header">
                {filteredSkills.length} skill{filteredSkills.length !== 1 ? "s" : ""}
                {skillFilter ? ` matching "${skillFilter}"` : ""}
                <span style={{ float: "right", opacity: 0.6 }}>↑↓ · Enter · Esc</span>
              </div>
              <div className="skill-picker-scroll" ref={pickerScrollRef}>
                {filteredSkills.map((s, i) => (
                  <div
                    key={s.name}
                    className={`skill-picker-item${i === pickerIdx ? " active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); insertSkill(s.name); }}
                    onMouseEnter={() => setPickerIdx(i)}
                  >
                    <span className="skill-picker-name">/{s.name}</span>
                    {s.description && <span className="skill-picker-desc">{s.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {showFilePicker && (
            <div className="skill-picker">
              <div className="skill-picker-header">
                <span>📁 Files</span>
                {fileQuery && <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>"{fileQuery}"</span>}
                <span style={{ float: "right", opacity: 0.6 }}>↑↓ · Enter · Esc</span>
              </div>
              <div className="skill-picker-scroll" ref={fileScrollRef}>
                {fileResults.length === 0 && (
                  <div style={{ padding: "12px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
                    {fileQuery ? `No files match "${fileQuery}"` : "Type a filename to search…"}
                  </div>
                )}
                {fileResults.map((path, i) => {
                  const parts = path.replace(/\\/g, "/").split("/");
                  const name = parts.pop() ?? path;
                  const dir = parts.join("/");
                  return (
                    <div
                      key={path}
                      className={`file-picker-item${i === fileIdx ? " active" : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); void insertFile(path); }}
                      onMouseEnter={() => setFileIdx(i)}
                    >
                      <span className="file-picker-name">{name}</span>
                      {dir && <span className="file-picker-dir">{dir}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="chat-input">
            <textarea
              ref={textareaRef}
              placeholder={
                status?.ready
                  ? "Message ARIS…  (/ skills · @ files · Enter to send · Shift+Enter for newline)"
                  : "Configure an API key in Settings first"
              }
              value={input}
              disabled={!status?.ready || busy}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
            />
            {busy ? (
              <button
                className="primary"
                onClick={() => void chatCancel()}
                title="Stop the running turn"
              >
                ■ Stop
              </button>
            ) : (
              <button
                className="primary"
                onClick={send}
                disabled={!status?.ready}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── File-change summary helpers ───────────────────────────────────────────────

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "str_replace_based_edit_tool"]);

interface FileChange { op: "write" | "edit"; path: string }

function extractFileChanges(blocks: ChatBlock[]): FileChange[] {
  const changes: FileChange[] = [];
  for (const b of blocks) {
    if (b.kind !== "tool" || !FILE_WRITE_TOOLS.has(b.name) || b.isError) continue;
    try {
      const parsed = JSON.parse(b.input) as Record<string, unknown>;
      const path = (parsed.path ?? parsed.file_path ?? parsed.target_file ?? "") as string;
      if (path) changes.push({ op: b.name === "write_file" ? "write" : "edit", path });
    } catch { /* ignore */ }
  }
  return changes;
}

function FileChangeSummary({ changes }: { changes: FileChange[] }) {
  if (changes.length === 0) return null;
  return (
    <div className="file-change-summary">
      <div className="file-change-header">
        <span className="file-change-icon">📝</span>
        {changes.length} file{changes.length > 1 ? "s" : ""} modified
      </div>
      <div className="file-change-list">
        {changes.map((c, i) => (
          <div key={i} className="file-change-item">
            <span className={`file-change-op op-${c.op}`}>{c.op === "write" ? "+" : "~"}</span>
            <span className="file-change-path">{c.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ChatBubble ─────────────────────────────────────────────────────────────────

function ChatBubble({
  turn,
  turnKey,
  collapsed,
  onToggleTool,
}: {
  turn: ChatTurn;
  turnKey: string;
  collapsed: Record<string, boolean>;
  onToggleTool: (key: string) => void;
}) {
  return (
    <div className={`chat-turn chat-${turn.role}`}>
      <div className="chat-role">{turn.role === "user" ? "You" : "ARIS"}</div>

      {/* Render blocks in arrival order */}
      {turn.blocks.map((block, i) => {
        if (block.kind === "text") {
          if (!block.text) return null;
          const isLast = i === turn.blocks.length - 1;
          return turn.role === "assistant" ? (
            <MarkdownContent key={i} text={block.text} streaming={isLast && turn.streaming} />
          ) : (
            <div key={i} className="chat-text">{block.text}</div>
          );
        }

        // Tool block
        const key = `${turnKey}-${i}`;
        const isDone = block.output !== undefined;
        const isRunning = !isDone;
        const isCollapsed = collapsed[key] !== false;
        const cls = isRunning ? "tool-running" : block.isError ? "tool-error" : "tool-done";

        return (
          <div key={i} className={`chat-tool ${cls}`}>
            <div
              className="chat-tool-header"
              onClick={() => isDone && onToggleTool(key)}
              style={{ cursor: isDone ? "pointer" : "default" }}
            >
              <span className="tool-status-icon">
                {isRunning ? "⟳" : block.isError ? "✗" : "✓"}
              </span>
              <span className="tool-name">{block.name}</span>
              {isDone && (
                <span className="tool-collapse-btn">{isCollapsed ? "▶" : "▼"}</span>
              )}
            </div>
            {!isCollapsed && (
              <div className="chat-tool-body">
                {block.input && block.input !== "{}" && (
                  <pre className="md-view tool-detail">{block.input}</pre>
                )}
                {block.output !== undefined && (
                  <pre className="md-view tool-detail tool-output">{block.output}</pre>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Streaming cursor */}
      {turn.streaming && turn.blocks.length === 0 && (
        <div className="chat-text chat-cursor">▋</div>
      )}
      {turn.streaming && turn.blocks.length > 0 && (
        <span className="chat-inline-cursor">▋</span>
      )}

      {/* File change summary – shown only when turn is complete */}
      {!turn.streaming && turn.role === "assistant" && (
        <FileChangeSummary changes={extractFileChanges(turn.blocks)} />
      )}
    </div>
  );
}
