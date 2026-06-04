import { useStore } from "../store";
import { fmtClock } from "../util";

function summarize(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    const pick = ["description", "title", "result", "name", "agentId", "to"]
      .map((k) => (typeof o[k] === "string" ? (o[k] as string) : null))
      .find(Boolean);
    if (pick) return pick;
    try {
      return JSON.stringify(payload).slice(0, 80);
    } catch {
      return "";
    }
  }
  return payload == null ? "" : String(payload);
}

export default function EventTimeline() {
  const events = useStore((s) => s.events);
  const ordered = [...events].reverse();

  return (
    <div className="side-panel" style={{ borderLeft: "none" }}>
      <div className="panel-title">Live events ({events.length})</div>
      <div className="scroll">
        {ordered.length === 0 && (
          <div className="empty">No events yet. Live updates appear here.</div>
        )}
        {ordered.map((e) => (
          <div className="event-row" key={e.eventId || `${e.ts}-${e.kind}`}>
            <div>
              <span className="kind">{e.kind}</span>{" "}
              <span className="ts">{fmtClock(e.ts)}</span>
            </div>
            <div className="meta" style={{ color: "var(--text-dim)" }}>
              {summarize(e.payload)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
