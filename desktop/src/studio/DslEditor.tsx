interface Props {
  script: string;
  error: string | null;
  onChange: (script: string) => void;
}

// P0 uses a styled <textarea>. Swapping in Monaco later is a drop-in upgrade
// (the script string stays the single source of truth either way).
export default function DslEditor({ script, error, onChange }: Props) {
  return (
    <div className="dsl-editor">
      <div className="panel-title">workflow.dsl</div>
      <textarea
        spellCheck={false}
        value={script}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <div className="err">⚠ {error}</div>}
    </div>
  );
}
