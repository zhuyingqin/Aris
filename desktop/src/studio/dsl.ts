// Workflow DSL <-> graph compiler.
//
// SINGLE SOURCE OF TRUTH for the grammar is the Rust parser at
// crates/tools/src/workflow_state.rs (`parse_workflow_script` / `extract_agent_spec`).
// This module must stay byte-compatible with it; any script we generate is also
// validated server-side via the `workflow_plan` command before start/save.
//
// Supported statements:
//   emitPhase("name")
//   spawnAgent({ description: "..", prompt: "..", subagentType?, name?, model? })
//   waitAll()
//   saveResult("key")
// with `//` line comments and optional `const`/`let`/`await` prefixes.

import type { WorkflowAgentSpec } from "../types";

export type Statement =
  | { kind: "phase"; name: string }
  | { kind: "agent"; spec: WorkflowAgentSpec }
  | { kind: "wait" }
  | { kind: "result"; key: string };

export interface ParseResult {
  statements: Statement[];
  error: string | null;
}

const firstQuoted = (line: string): string | null => {
  const m = line.match(/"((?:[^"\\]|\\.)*)"/);
  return m ? unescapeStr(m[1]) : null;
};

const objectField = (object: string, key: string): string | null => {
  const re = new RegExp(`${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = object.match(re);
  return m ? unescapeStr(m[1]) : null;
};

const unescapeStr = (s: string): string => s.replace(/\\(["\\])/g, "$1");
const escapeStr = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const parseAgent = (line: string): WorkflowAgentSpec => {
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  if (start < 0 || end < 0) {
    throw new Error("spawnAgent requires an object literal");
  }
  const object = line.slice(start + 1, end);
  const description = objectField(object, "description");
  const prompt = objectField(object, "prompt");
  if (description == null) throw new Error("spawnAgent requires description");
  if (prompt == null) throw new Error("spawnAgent requires prompt");
  return {
    description,
    prompt,
    subagentType:
      objectField(object, "subagentType") ??
      objectField(object, "subagent_type") ??
      null,
    name: objectField(object, "name"),
    model: objectField(object, "model"),
  };
};

export function parseScript(script: string): ParseResult {
  const statements: Statement[] = [];
  const lines = script.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;

    const normalized = line
      .replace(/^const\s+/, "")
      .replace(/^let\s+/, "")
      .replace(/^await\s+/, "")
      // strip an assignment target: `a = spawnAgent(...)`
      .replace(/^[A-Za-z_$][\w$]*\s*=\s*/, "")
      .trim();

    try {
      if (normalized.startsWith("emitPhase")) {
        const name = firstQuoted(normalized);
        if (name == null) throw new Error("emitPhase requires a string");
        statements.push({ kind: "phase", name });
      } else if (normalized.startsWith("spawnAgent")) {
        statements.push({ kind: "agent", spec: parseAgent(normalized) });
      } else if (normalized.startsWith("waitAll")) {
        statements.push({ kind: "wait" });
      } else if (normalized.startsWith("saveResult")) {
        const key = firstQuoted(normalized);
        if (key == null) throw new Error("saveResult requires a string");
        statements.push({ kind: "result", key });
      } else {
        return {
          statements,
          error: `unsupported workflow script statement: ${line}. Allowed APIs: emitPhase, spawnAgent, waitAll, saveResult`,
        };
      }
    } catch (err) {
      return { statements, error: String(err instanceof Error ? err.message : err) };
    }
  }
  return { statements, error: null };
}

export function generateScript(statements: Statement[]): string {
  const out: string[] = [];
  for (const stmt of statements) {
    switch (stmt.kind) {
      case "phase":
        out.push(`emitPhase("${escapeStr(stmt.name)}")`);
        break;
      case "agent": {
        const parts = [
          `description: "${escapeStr(stmt.spec.description)}"`,
          `prompt: "${escapeStr(stmt.spec.prompt)}"`,
        ];
        if (stmt.spec.subagentType)
          parts.push(`subagentType: "${escapeStr(stmt.spec.subagentType)}"`);
        if (stmt.spec.name) parts.push(`name: "${escapeStr(stmt.spec.name)}"`);
        if (stmt.spec.model) parts.push(`model: "${escapeStr(stmt.spec.model)}"`);
        out.push(`spawnAgent({ ${parts.join(", ")} })`);
        break;
      }
      case "wait":
        out.push("waitAll()");
        break;
      case "result":
        out.push(`saveResult("${escapeStr(stmt.key)}")`);
        break;
    }
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

// ── Graph projection (statements -> React Flow nodes/edges) ───────────────────

export interface FlowNodeData {
  label: string;
  statementIndex: number; // -1 for synthetic
  spec?: WorkflowAgentSpec;
  resultKey?: string;
}

export interface FlowNode {
  id: string;
  type: "phase" | "agent" | "barrier" | "result";
  position: { x: number; y: number };
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

const COL_W = 260;
const ROW_H = 104;

interface Column {
  kind: "phase" | "barrier" | "result";
  mainId: string;
  stmtIndex: number;
  label: string;
  resultKey?: string;
  agents: { id: string; stmtIndex: number; spec: WorkflowAgentSpec }[];
}

export function toFlow(statements: Statement[]): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const columns: Column[] = [];
  let current: Column | null = null;
  let synthetic = 0;

  statements.forEach((stmt, i) => {
    if (stmt.kind === "phase") {
      current = {
        kind: "phase",
        mainId: `n${i}`,
        stmtIndex: i,
        label: stmt.name,
        agents: [],
      };
      columns.push(current);
    } else if (stmt.kind === "agent") {
      if (!current || current.kind !== "phase") {
        current = {
          kind: "phase",
          mainId: `syn${synthetic++}`,
          stmtIndex: -1,
          label: "(implicit phase)",
          agents: [],
        };
        columns.push(current);
      }
      current.agents.push({ id: `a${i}`, stmtIndex: i, spec: stmt.spec });
    } else if (stmt.kind === "wait") {
      columns.push({
        kind: "barrier",
        mainId: `n${i}`,
        stmtIndex: i,
        label: "waitAll",
        agents: [],
      });
      current = null;
    } else if (stmt.kind === "result") {
      columns.push({
        kind: "result",
        mainId: `n${i}`,
        stmtIndex: i,
        label: stmt.key,
        resultKey: stmt.key,
        agents: [],
      });
      current = null;
    }
  });

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const pushEdge = (source: string, target: string) =>
    edges.push({ id: `e-${source}-${target}`, source, target });

  columns.forEach((col, c) => {
    const x = c * COL_W;
    nodes.push({
      id: col.mainId,
      type: col.kind,
      position: { x, y: 0 },
      data: {
        label: col.label,
        statementIndex: col.stmtIndex,
        resultKey: col.resultKey,
      },
    });
    // backbone: previous column main -> this column main
    if (c > 0) pushEdge(columns[c - 1].mainId, col.mainId);

    // agents stacked beneath their phase
    col.agents.forEach((agent, k) => {
      nodes.push({
        id: agent.id,
        type: "agent",
        position: { x, y: (k + 1) * ROW_H },
        data: {
          label: agent.spec.description,
          statementIndex: agent.stmtIndex,
          spec: agent.spec,
        },
      });
      pushEdge(col.mainId, agent.id);
      // fan-in to the next barrier / result, if any
      const next = columns[c + 1];
      if (next && (next.kind === "barrier" || next.kind === "result")) {
        pushEdge(agent.id, next.mainId);
      }
    });
  });

  return { nodes, edges };
}

// ── Inverse: free-form graph -> statements (linearization) ────────────────────
//
// The runtime DSL is strictly linear (phases in order, agents inside a phase,
// waitAll barriers, one final result). A free-form canvas is therefore only
// valid if its STAGE nodes (phase/barrier/result) form a single chain. Agents
// attach to a phase via a `phase -> agent` edge. This compiles such a graph
// back into ordered statements, or returns a clear error.

export interface GraphInputNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data: FlowNodeData;
}
export interface GraphInputEdge {
  source: string;
  target: string;
}

export interface GraphCompileResult {
  statements: Statement[];
  error: string | null;
  orphanAgents: number;
}

export function graphToStatements(
  nodes: GraphInputNode[],
  edges: GraphInputEdge[],
): GraphCompileResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isStage = (n: GraphInputNode | undefined) =>
    !!n && (n.type === "phase" || n.type === "barrier" || n.type === "result");
  const stages = nodes.filter(isStage);
  const agents = nodes.filter((n) => n.type === "agent");

  if (stages.length === 0) {
    return {
      statements: [],
      error: agents.length
        ? "add a phase and connect your agents to it"
        : "canvas is empty",
      orphanAgents: agents.length,
    };
  }

  // backbone (stage -> stage) and membership (phase -> agent)
  const next = new Map<string, string[]>();
  const indeg = new Map<string, number>(stages.map((s) => [s.id, 0]));
  const memberOf = new Map<string, string>(); // agentId -> phaseId
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    if (isStage(s) && isStage(t)) {
      next.set(s.id, [...(next.get(s.id) ?? []), t.id]);
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
    } else if (s.type === "phase" && t.type === "agent") {
      memberOf.set(t.id, s.id);
    }
  }

  const starts = stages.filter((s) => (indeg.get(s.id) ?? 0) === 0);
  if (starts.length !== 1) {
    return {
      statements: [],
      error: `the flow must have exactly one start (found ${starts.length}); connect every node into a single sequence`,
      orphanAgents: 0,
    };
  }

  // follow the single chain
  const order: GraphInputNode[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = starts[0].id;
  while (cur) {
    if (seen.has(cur)) {
      return { statements: [], error: "the flow has a cycle", orphanAgents: 0 };
    }
    seen.add(cur);
    order.push(byId.get(cur)!);
    const outs: string[] = next.get(cur) ?? [];
    if (outs.length > 1) {
      return {
        statements: [],
        error: "a node has more than one outgoing connection (flow is not linear)",
        orphanAgents: 0,
      };
    }
    cur = outs[0];
  }
  if (order.length !== stages.length) {
    return {
      statements: [],
      error: "every node must be part of one connected sequence",
      orphanAgents: 0,
    };
  }

  // group agents by phase, ordered top-to-bottom
  const membersByPhase = new Map<string, GraphInputNode[]>();
  let orphanAgents = 0;
  for (const a of agents) {
    const phaseId = memberOf.get(a.id);
    if (!phaseId) {
      orphanAgents += 1;
      continue;
    }
    membersByPhase.set(phaseId, [...(membersByPhase.get(phaseId) ?? []), a]);
  }
  for (const list of membersByPhase.values()) {
    list.sort((p, q) => (p.position?.y ?? 0) - (q.position?.y ?? 0));
  }

  const statements: Statement[] = [];
  for (const stage of order) {
    if (stage.type === "phase") {
      statements.push({ kind: "phase", name: stage.data.label || "phase" });
      for (const a of membersByPhase.get(stage.id) ?? []) {
        if (a.data.spec) statements.push({ kind: "agent", spec: a.data.spec });
      }
    } else if (stage.type === "barrier") {
      statements.push({ kind: "wait" });
    } else if (stage.type === "result") {
      statements.push({
        kind: "result",
        key: stage.data.resultKey || stage.data.label || "result",
      });
    }
  }

  return { statements, error: null, orphanAgents };
}

export const EXAMPLE_SCRIPT = `// A two-phase research workflow.
emitPhase("Survey")
spawnAgent({ description: "Literature survey", prompt: "Survey recent work and summarize key methods.", subagentType: "Explore" })
spawnAgent({ description: "Codebase scan", prompt: "Map the relevant modules and entry points.", subagentType: "general-purpose" })
waitAll()
emitPhase("Synthesize")
spawnAgent({ description: "Write report", prompt: "Integrate upstream findings into a single report." })
saveResult("research_report")
`;
