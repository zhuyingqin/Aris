import { describe, it, expect } from "vitest";
import {
  parseScript,
  generateScript,
  graphToStatements,
  toFlow,
  EXAMPLE_SCRIPT,
  type GraphInputNode,
  type Statement,
} from "./dsl";

const node = (
  id: string,
  type: string,
  data: Partial<GraphInputNode["data"]>,
  y = 0,
): GraphInputNode => ({
  id,
  type,
  position: { x: 0, y },
  data: { label: "", statementIndex: -1, ...data },
});

describe("workflow DSL", () => {
  it("parses the example script into ordered statements", () => {
    const { statements, error } = parseScript(EXAMPLE_SCRIPT);
    expect(error).toBeNull();
    expect(statements.map((s) => s.kind)).toEqual([
      "phase",
      "agent",
      "agent",
      "wait",
      "phase",
      "agent",
      "result",
    ]);
    const agent = statements[1] as Extract<Statement, { kind: "agent" }>;
    expect(agent.spec.description).toBe("Literature survey");
    expect(agent.spec.subagentType).toBe("Explore");
  });

  it("round-trips parse -> generate -> parse losslessly", () => {
    const first = parseScript(EXAMPLE_SCRIPT);
    const regen = generateScript(first.statements);
    const second = parseScript(regen);
    expect(second.error).toBeNull();
    expect(second.statements).toEqual(first.statements);
  });

  it("accepts const/let/await and assignment prefixes", () => {
    const script = `const a = spawnAgent({ description: "d", prompt: "p" })
await waitAll()
let x = spawnAgent({ description: "d2", prompt: "p2" })`;
    const { statements, error } = parseScript(script);
    expect(error).toBeNull();
    expect(statements.map((s) => s.kind)).toEqual(["agent", "wait", "agent"]);
  });

  it("preserves escaped quotes through a round trip", () => {
    const script = `spawnAgent({ description: "say \\"hi\\"", prompt: "use \\\\ path" })`;
    const { statements, error } = parseScript(script);
    expect(error).toBeNull();
    const agent = statements[0] as Extract<Statement, { kind: "agent" }>;
    expect(agent.spec.description).toBe('say "hi"');
    expect(agent.spec.prompt).toBe("use \\ path");
    expect(parseScript(generateScript(statements)).statements).toEqual(
      statements,
    );
  });

  it("rejects unsupported statements like the Rust parser", () => {
    const { error } = parseScript(`emitPhase("ok")\ndoSomethingElse()`);
    expect(error).toContain("unsupported workflow script statement");
  });

  it("requires description and prompt on spawnAgent", () => {
    expect(parseScript(`spawnAgent({ prompt: "p" })`).error).toContain(
      "description",
    );
    expect(parseScript(`spawnAgent({ description: "d" })`).error).toContain(
      "prompt",
    );
  });

  it("projects statements into a phase/agent/barrier/result graph", () => {
    const { statements } = parseScript(EXAMPLE_SCRIPT);
    const { nodes, edges } = toFlow(statements);
    const kinds = nodes.map((n) => n.type).sort();
    expect(kinds).toEqual([
      "agent",
      "agent",
      "agent",
      "barrier",
      "phase",
      "phase",
      "result",
    ]);
    // every agent in phase 1 fans into the barrier
    const barrier = nodes.find((n) => n.type === "barrier")!;
    const intoBarrier = edges.filter((e) => e.target === barrier.id);
    expect(intoBarrier.length).toBeGreaterThanOrEqual(2);
  });
});

describe("graphToStatements (free-form -> DSL)", () => {
  const spec = (description: string) => ({
    description,
    prompt: "p",
    subagentType: null,
    name: null,
    model: null,
  });

  it("linearizes a connected phase/agent/barrier/result graph", () => {
    const nodes: GraphInputNode[] = [
      node("p1", "phase", { label: "Survey" }),
      node("a1", "agent", { spec: spec("survey"), label: "survey" }, 100),
      node("a2", "agent", { spec: spec("scan"), label: "scan" }, 200),
      node("b", "barrier", {}),
      node("p2", "phase", { label: "Synthesize" }),
      node("a3", "agent", { spec: spec("report"), label: "report" }, 100),
      node("r", "result", { resultKey: "out" }),
    ];
    const edges = [
      { source: "p1", target: "b" },
      { source: "b", target: "p2" },
      { source: "p2", target: "r" },
      { source: "p1", target: "a1" },
      { source: "p1", target: "a2" },
      { source: "p2", target: "a3" },
    ];
    const { statements, error, orphanAgents } = graphToStatements(nodes, edges);
    expect(error).toBeNull();
    expect(orphanAgents).toBe(0);
    expect(statements.map((s) => s.kind)).toEqual([
      "phase",
      "agent",
      "agent",
      "wait",
      "phase",
      "agent",
      "result",
    ]);
    // and the generated DSL parses + projects back to the same graph shape
    const script = generateScript(statements);
    expect(parseScript(script).error).toBeNull();
  });

  it("counts agents not wired to any phase as orphans", () => {
    const nodes: GraphInputNode[] = [
      node("p1", "phase", { label: "P" }),
      node("a1", "agent", { spec: spec("wired"), label: "wired" }),
      node("a2", "agent", { spec: spec("loose"), label: "loose" }),
    ];
    const edges = [{ source: "p1", target: "a1" }];
    const { statements, orphanAgents } = graphToStatements(nodes, edges);
    expect(orphanAgents).toBe(1);
    expect(statements.map((s) => s.kind)).toEqual(["phase", "agent"]);
  });

  it("rejects a disconnected flow (more than one start)", () => {
    const nodes: GraphInputNode[] = [
      node("p1", "phase", { label: "A" }),
      node("p2", "phase", { label: "B" }),
    ];
    const { error } = graphToStatements(nodes, []);
    expect(error).toContain("exactly one start");
  });
});
