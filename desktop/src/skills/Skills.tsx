import { useEffect, useMemo, useState } from "react";
import { isTauri, skillView, skillsList } from "../api/tauri";
import { useStore } from "../store";
import type { SkillMeta } from "../types";

export default function Skills() {
  const setError = useStore((s) => s.setError);
  const projectId = useStore((s) => s.currentProject?.id);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");

  useEffect(() => {
    if (!isTauri()) return;
    setSelected(null);
    setContent("");
    skillsList().then(setSkills).catch((e) => setError(String(e)));
  }, [projectId, setError]);

  useEffect(() => {
    if (!selected) {
      setContent("");
      return;
    }
    let cancelled = false;
    setContent("Loading…");
    skillView(selected)
      .then((value) => {
        if (!cancelled) setContent(value);
      })
      .catch((e) => {
        if (!cancelled) setContent(`Error: ${e}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [skills, filter]);

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">
          Skills need the Tauri backend. Run <code>npm run tauri dev</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="split">
      <div className="runs-list">
        <div className="panel-title">Skills ({skills.length})</div>
        <div style={{ padding: 8 }}>
          <input
            style={{ width: "100%" }}
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {shown.map((s) => (
          <button
            type="button"
            key={s.name}
            className={`run-row${s.name === selected ? " active" : ""}`}
            onClick={() => setSelected(s.name)}
          >
            <div className="name">/{s.name}</div>
            {s.description && (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {s.description}
              </div>
            )}
            <div className="sub">
              {s.path.startsWith("<bundled") ? "bundled" : s.path}
            </div>
          </button>
        ))}
      </div>

      <div className="detail">
        {selected ? (
          <>
            <div className="panel-title">/{selected} — SKILL.md</div>
            <pre className="md-view">{content}</pre>
          </>
        ) : (
          <div className="empty">Select a skill to read its SKILL.md.</div>
        )}
      </div>
    </div>
  );
}
