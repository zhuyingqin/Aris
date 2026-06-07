import { useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "reactflow";
import WorkflowCanvas from "./WorkflowCanvas";
import FreeformBoard from "./FreeformBoard";
import DslEditor from "./DslEditor";
import Inspector from "./Inspector";
import {
  EXAMPLE_SCRIPT,
  generateScript,
  parseScript,
  toFlow,
  type Statement,
} from "./dsl";
import { useStore } from "../store";
import { workflowPlan, workflowSave, workflowStart } from "../api/tauri";
import type { WorkflowApproval } from "../types";

export default function Studio() {
  const [script, setScript] = useState(EXAMPLE_SCRIPT);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [approval, setApproval] = useState<WorkflowApproval>("allow_once");
  const [name, setName] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [mode, setMode] = useState<"dsl" | "freeform">("dsl");
  const [seedNonce, setSeedNonce] = useState(0);
  const [pendingAction, setPendingAction] = useState<"plan" | "save" | "start" | null>(null);
  const pendingActionRef = useRef<typeof pendingAction>(null);

  const setTab = useStore((s) => s.setTab);
  const selectRun = useStore((s) => s.selectRun);
  const refreshRuns = useStore((s) => s.refreshRuns);
  const setError = useStore((s) => s.setError);

  const { statements, error } = useMemo(() => parseScript(script), [script]);
  const flow = useMemo(() => toFlow(statements), [statements]);

  const applyStatements = (next: Statement[]) => {
    setScript(generateScript(next));
  };

  const insert = (stmt: Statement) => {
    const next = statements.slice();
    const lastIsResult = next.length && next[next.length - 1].kind === "result";
    if (stmt.kind === "result") {
      if (lastIsResult) return; // a single result terminus
      next.push(stmt);
    } else if (lastIsResult) {
      next.splice(next.length - 1, 0, stmt);
    } else {
      next.push(stmt);
    }
    applyStatements(next);
  };

  const addAgent = () =>
    insert({
      kind: "agent",
      spec: {
        description: "New agent",
        prompt: "Describe the task for this agent.",
        subagentType: null,
        name: null,
        model: null,
      },
    });

  const doPlan = async () => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = "plan";
    setPendingAction("plan");
    setInfo(null);
    try {
      const out = await workflowPlan(script);
      const p = out.plan;
      setInfo(
        p
          ? `Plan OK — ${p.phases.length} phase(s), ${p.agents.length} agent(s), ${p.waits} barrier(s)${p.finalResult ? `, result "${p.finalResult}"` : ""}.`
          : (out.message ?? "planned"),
      );
    } catch (err) {
      setError(String(err));
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  const doSave = async () => {
    if (pendingActionRef.current) return;
    const wfName = window.prompt("Save workflow as:", name || "my-workflow");
    if (!wfName) return;
    pendingActionRef.current = "save";
    setPendingAction("save");
    try {
      const out = await workflowSave(wfName, script);
      setInfo(out.message ?? `Saved "${wfName}".`);
    } catch (err) {
      setError(String(err));
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  const doStart = async () => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = "start";
    setPendingAction("start");
    try {
      const out = await workflowStart({
        script,
        approval,
        name: name || undefined,
      });
      await refreshRuns();
      if (out.run) selectRun(out.run.runId);
      setInfo(out.message ?? null);
      setTab("monitor");
    } catch (err) {
      setError(String(err));
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  return (
    <div className="studio-root">
      <div className="mode-bar">
        <button
          className={mode === "dsl" ? "seg active" : "seg"}
          onClick={() => setMode("dsl")}
        >
          DSL-driven
        </button>
        <button
          className={mode === "freeform" ? "seg active" : "seg"}
          onClick={() => {
            setSeedNonce((n) => n + 1);
            setMode("freeform");
          }}
        >
          Free-form canvas
        </button>
        <span className="hint" style={{ marginLeft: 8 }}>
          {mode === "freeform"
            ? "drag & wire nodes, then Apply → DSL"
            : "edit text / inspector; the canvas mirrors the DSL"}
        </span>
      </div>

      {mode === "freeform" ? (
        <ReactFlowProvider key={seedNonce}>
          <FreeformBoard seed={statements} onApply={setScript} />
        </ReactFlowProvider>
      ) : (
        <div className="studio">
          <div className="studio-toolbar">
            <button onClick={() => insert({ kind: "phase", name: "New phase" })}>
          + Phase
        </button>
        <button onClick={addAgent}>+ Agent</button>
        <button onClick={() => insert({ kind: "wait" })}>+ waitAll</button>
        <button onClick={() => insert({ kind: "result", key: "result" })}>
          + Result
        </button>
        <span className="spacer" />
        {info && <span className="hint">{info}</span>}
        <button onClick={doPlan} disabled={Boolean(pendingAction) || Boolean(error)}>
          {pendingAction === "plan" ? "Planning..." : "Plan"}
        </button>
        <button onClick={doSave} disabled={Boolean(pendingAction) || Boolean(error)}>
          {pendingAction === "save" ? "Saving..." : "Save"}
        </button>
        <input
          style={{ width: 130 }}
          placeholder="run name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          value={approval}
          onChange={(e) => setApproval(e.target.value as WorkflowApproval)}
          title="approval gate"
        >
          <option value="allow_once">allow once</option>
          <option value="always">always</option>
          <option value="deny">deny</option>
        </select>
        <button className="primary" onClick={doStart} disabled={Boolean(error) || Boolean(pendingAction)}>
          {pendingAction === "start" ? "Starting..." : "Start"}
        </button>
      </div>

      <div className="canvas-wrap">
        <ReactFlowProvider>
          <WorkflowCanvas
            nodes={flow.nodes}
            edges={flow.edges}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
          />
        </ReactFlowProvider>
      </div>

      <div className="studio-side">
        <DslEditor script={script} error={error} onChange={setScript} />
        <Inspector
          statements={statements}
          selectedIndex={selectedIndex}
          onChange={applyStatements}
        />
          </div>
        </div>
      )}
    </div>
  );
}
