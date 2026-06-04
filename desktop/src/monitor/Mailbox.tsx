import { useStore } from "../store";
import { fmtClock } from "../util";

export default function Mailbox() {
  const team = useStore((s) => s.team);
  const messages = team?.mailbox ?? [];

  return (
    <div className="side-panel">
      <div className="panel-title">Mailbox ({messages.length})</div>
      <div className="scroll">
        {messages.length === 0 && (
          <div className="empty">No team messages.</div>
        )}
        {messages.map((m, i) => (
          <div className="msg-row" key={m.messageId ?? i}>
            <div>
              <strong>{m.from}</strong> → {m.to}{" "}
              <span className="ts">{fmtClock(m.createdAt)}</span>
            </div>
            {m.subject && <div style={{ fontWeight: 600 }}>{m.subject}</div>}
            <div style={{ color: "var(--text-dim)" }}>{m.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
