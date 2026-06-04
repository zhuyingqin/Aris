import { useEffect, useRef, useState } from "react";
import {
  chatReset,
  chatSend,
  chatStatus,
  isTauri,
  onChatDelta,
  onChatDone,
  onChatTool,
  onChatToolResult,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatStatus, ChatTurn } from "../types";

export default function Chat() {
  const setTab = useStore((s) => s.setTab);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const updateLastAssistant = (fn: (t: ChatTurn) => ChatTurn) =>
    setTurns((ts) => {
      const copy = ts.slice();
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant") {
          copy[i] = fn(copy[i]);
          break;
        }
      }
      return copy;
    });

  useEffect(() => {
    if (!isTauri()) return;
    chatStatus().then(setStatus).catch((e) => setStatus({ ready: false, message: String(e) }));

    const unlisteners: Promise<() => void>[] = [
      onChatDelta((text) =>
        updateLastAssistant((t) => ({ ...t, text: t.text + text })),
      ),
      onChatTool((tool) =>
        updateLastAssistant((t) => ({
          ...t,
          tools: [...t.tools, { id: tool.id, name: tool.name, input: tool.input }],
        })),
      ),
      onChatToolResult((res) =>
        updateLastAssistant((t) => {
          const tools = t.tools.slice();
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i].output === undefined && tools[i].name === res.name) {
              tools[i] = { ...tools[i], output: res.output, isError: res.isError };
              break;
            }
          }
          return { ...t, tools };
        }),
      ),
      onChatDone(() => updateLastAssistant((t) => ({ ...t, streaming: false }))),
    ];

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => undefined));
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setTurns((ts) => [
      ...ts,
      { role: "user", text, tools: [] },
      { role: "assistant", text: "", tools: [], streaming: true },
    ]);
    try {
      const reply = await chatSend(text);
      updateLastAssistant((t) => ({
        ...t,
        text: reply || t.text,
        streaming: false,
      }));
    } catch (e) {
      updateLastAssistant((t) => ({
        ...t,
        text: t.text + `\n\n⚠ ${e}`,
        streaming: false,
      }));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    await chatReset().catch(() => undefined);
    setTurns([]);
  };

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">
          Chat needs the Tauri backend. Run <code>npm run tauri dev</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <div>
          {status?.ready ? (
            <span className="hint">
              executor: <b>{status.model}</b> ({status.provider})
            </span>
          ) : (
            <span className="err" style={{ padding: 0 }}>
              {status?.message ?? "checking…"}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!status?.ready && (
            <button onClick={() => setTab("settings")}>Open Settings</button>
          )}
          <button onClick={reset} disabled={busy}>New chat</button>
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="empty">
            Ask ARIS anything. The executor streams here; tool calls and the
            adversarial reviewer (LlmReview) show inline.
          </div>
        )}
        {turns.map((t, i) => (
          <ChatBubble key={i} turn={t} />
        ))}
      </div>

      <div className="chat-input">
        <textarea
          placeholder={status?.ready ? "Message ARIS…  (Enter to send, Shift+Enter for newline)" : "Configure an Anthropic key in Settings first"}
          value={input}
          disabled={!status?.ready || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" onClick={send} disabled={!status?.ready || busy}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function ChatBubble({ turn }: { turn: ChatTurn }) {
  return (
    <div className={`chat-turn chat-${turn.role}`}>
      <div className="chat-role">{turn.role}</div>
      {turn.text && <div className="chat-text">{turn.text}</div>}
      {turn.tools.map((tool, i) => (
        <div key={i} className="chat-tool">
          <span className="tag">
            {tool.output === undefined ? "▶" : tool.isError ? "✗" : "✓"} {tool.name}
          </span>
          {tool.input && tool.input !== "{}" && (
            <pre className="md-view">{tool.input}</pre>
          )}
          {tool.output !== undefined && (
            <pre className="md-view">{tool.output}</pre>
          )}
        </div>
      ))}
      {turn.streaming && !turn.text && turn.tools.length === 0 && (
        <div className="chat-text" style={{ color: "var(--text-dim)" }}>▋</div>
      )}
    </div>
  );
}
