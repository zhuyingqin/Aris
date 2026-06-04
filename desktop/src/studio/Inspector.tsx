import type { Statement } from "./dsl";
import type { WorkflowAgentSpec } from "../types";

interface Props {
  statements: Statement[];
  selectedIndex: number | null;
  onChange: (statements: Statement[]) => void;
}

export default function Inspector({
  statements,
  selectedIndex,
  onChange,
}: Props) {
  if (selectedIndex == null || !statements[selectedIndex]) {
    return (
      <div className="hint">
        Select a node to edit it, or use the toolbar to add phases, agents,
        barriers and a result.
      </div>
    );
  }

  const stmt = statements[selectedIndex];
  const replace = (next: Statement) => {
    const copy = statements.slice();
    copy[selectedIndex] = next;
    onChange(copy);
  };
  const remove = () => {
    onChange(statements.filter((_, i) => i !== selectedIndex));
  };

  const Text = (props: {
    label: string;
    value: string;
    onText: (v: string) => void;
    area?: boolean;
  }) => (
    <div className="field">
      <label>{props.label}</label>
      {props.area ? (
        <textarea
          rows={4}
          value={props.value}
          onChange={(e) => props.onText(e.target.value)}
        />
      ) : (
        <input
          value={props.value}
          onChange={(e) => props.onText(e.target.value)}
        />
      )}
    </div>
  );

  return (
    <div className="inspector">
      {stmt.kind === "phase" && (
        <>
          <div className="panel-title">Phase</div>
          <Text
            label="name"
            value={stmt.name}
            onText={(name) => replace({ kind: "phase", name })}
          />
        </>
      )}

      {stmt.kind === "agent" && (
        <>
          <div className="panel-title">Agent</div>
          {(
            [
              ["description", "description", false],
              ["prompt", "prompt", true],
              ["subagentType", "subagent type (e.g. Explore)", false],
              ["name", "name", false],
              ["model", "model (e.g. gpt-5.5)", false],
            ] as [keyof WorkflowAgentSpec, string, boolean][]
          ).map(([key, label, area]) => (
            <Text
              key={key}
              label={label}
              area={area}
              value={(stmt.spec[key] as string) ?? ""}
              onText={(v) =>
                replace({
                  kind: "agent",
                  spec: { ...stmt.spec, [key]: v === "" ? null : v },
                })
              }
            />
          ))}
        </>
      )}

      {stmt.kind === "wait" && (
        <>
          <div className="panel-title">Barrier</div>
          <div className="hint">
            waitAll() — blocks until every agent in the current phase finishes.
          </div>
        </>
      )}

      {stmt.kind === "result" && (
        <>
          <div className="panel-title">Result</div>
          <Text
            label="result key"
            value={stmt.key}
            onText={(key) => replace({ kind: "result", key })}
          />
        </>
      )}

      <button onClick={remove}>Remove node</button>
    </div>
  );
}
