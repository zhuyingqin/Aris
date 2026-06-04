import { useStore } from "../store";
import RunBoard from "./RunBoard";
import EventTimeline from "./EventTimeline";
import Mailbox from "./Mailbox";
import { Badge } from "../util";

export default function Monitor() {
  const runs = useStore((s) => s.runs);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const selectRun = useStore((s) => s.selectRun);

  return (
    <div className="monitor">
      <div className="runs-list">
        <div className="panel-title">Workflow runs ({runs.length})</div>
        {runs.length === 0 && (
          <div className="empty">No runs yet.</div>
        )}
        {runs.map((r) => (
          <div
            key={r.runId}
            className={`run-row${r.runId === selectedRunId ? " active" : ""}`}
            onClick={() => selectRun(r.runId)}
          >
            <div className="name">{r.name}</div>
            <div style={{ margin: "4px 0" }}>
              <Badge status={r.status} />
            </div>
            <div className="sub">{r.runId}</div>
          </div>
        ))}
      </div>

      <RunBoard />

      <div className="mon-right">
        <EventTimeline />
        <Mailbox />
      </div>
    </div>
  );
}
