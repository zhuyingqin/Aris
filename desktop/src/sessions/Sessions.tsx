import { useEffect, useState } from "react";
import { isTauri, sessionGet, sessionsList } from "../api/tauri";
import { useStore } from "../store";
import { fmtTs } from "../util";
import type { SessionMessage, SessionSummary } from "../types";

export default function Sessions() {
  const setError = useStore((s) => s.setError);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    sessionsList().then(setSessions).catch((e) => setError(String(e)));
  }, [setError]);

  useEffect(() => {
    if (!selected) return;
    sessionGet(selected)
      .then((t) => setMessages(t.messages))
      .catch((e) => setError(String(e)));
  }, [selected, setError]);

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">
          Sessions need the Tauri backend. Run <code>npm run tauri dev</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="split">
      <div className="runs-list">
        <div className="panel-title">Sessions ({sessions.length})</div>
        {sessions.length === 0 && <div className="empty">No saved sessions.</div>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`run-row${s.id === selected ? " active" : ""}`}
            onClick={() => setSelected(s.id)}
          >
            <div className="name">{s.id}</div>
            <div className="sub">
              {s.messageCount} msgs · {fmtTs(s.modifiedEpochSecs)}
            </div>
          </div>
        ))}
      </div>

      <div className="detail scroll">
        {!selected && <div className="empty">Select a session to read its transcript.</div>}
        {selected &&
          messages.map((m, i) => <MessageView key={i} message={m} />)}
      </div>
    </div>
  );
}

function MessageView({ message }: { message: SessionMessage }) {
  return (
    <div className={`msg msg-${message.role}`}>
      <div className="msg-role">{message.role}</div>
      {message.blocks.map((b, i) => {
        if (b.kind === "text") return <div key={i} className="msg-text">{b.text}</div>;
        if (b.kind === "thinking")
          return (
            <div key={i} className="msg-thinking">💭 {b.thinking}</div>
          );
        if (b.kind === "toolUse")
          return (
            <div key={i} className="msg-tool">
              <span className="tag">tool ▶ {b.name}</span>
              <pre className="md-view">{b.input}</pre>
            </div>
          );
        return (
          <div key={i} className="msg-tool">
            <span className="tag">{b.isError ? "tool ✗" : "tool ✓"} {b.toolName}</span>
            <pre className="md-view">{b.output}</pre>
          </div>
        );
      })}
    </div>
  );
}
