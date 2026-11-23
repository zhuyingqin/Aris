"""Prepare inputs for the Rust replay (crates/runtime/examples/memory_replay.rs).

L0: copies each probe project's sessions directory (Session JSON, event logs
and the EXISTING session-index.sqlite3, mtimes preserved) to a scratch dir, so
the replay exercises the real upgrade path: an old index without the bigram
table, then the background backfill. Writes replay/l0.json.

L1: v7 lesson notes stand in for the writer's output; each labelled failure
event is replayed against the notes written before it. Writes replay/l1.json.

Everything written here holds private text and stays outside the repo.
Usage: python prep_replay.py [--scratch E:/tmp/memexp-replay]
"""
import argparse
import glob
import json
import os
import re
import shutil
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DATA = r"F:\Agent\memory-exp-data"
BENCH = r"F:\Agent\memory-l1-dataset\benchmark"
NOTES = r"F:\Agent\memory-l1-dataset\results\notes_v7.jsonl"
LESSON_NOTES = r"F:\Agent\memory-l1-dataset\results\lesson_notes_v7.json"
RUNTIME = os.path.join(os.path.expanduser("~"), ".config", "SomniQ", "desktop-runtime")


def sessions_dir_of(project):
    if project == "default":
        return os.path.join(RUNTIME, "sessions")
    return os.path.join(RUNTIME, "projects", project, "sessions")


def collapse(text):
    return re.sub(r"\s+", " ", text or "").strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scratch", default=r"E:\tmp\memexp-replay")
    args = parser.parse_args()
    out_dir = os.path.join(DATA, "replay")
    os.makedirs(out_dir, exist_ok=True)
    db = sqlite3.connect(os.path.join(DATA, "corpus.sqlite"))
    starts = {s: t for s, t in db.execute("SELECT session_id, start_ts FROM sessions")}
    proj_starts = {}
    for s, p, t in db.execute("SELECT session_id, project, start_ts FROM sessions"):
        proj_starts.setdefault(p, []).append(t)
    turns = {r[0]: r[1:] for r in db.execute("SELECT turn_id, session_id, turn_index, user_text FROM turns")}

    # ---------------- L0 ----------------
    probes = json.load(open(os.path.join(DATA, "probes.json"), encoding="utf-8"))
    copied = {}
    rows = []
    for p in probes:
        if p["turn_id"] not in turns:
            continue
        session, index, _ = turns[p["turn_id"]]
        project = p["project"]
        if project not in copied:
            src = sessions_dir_of(project)
            dst = os.path.join(args.scratch, project, "sessions")
            if os.path.exists(dst):
                shutil.rmtree(dst)
            os.makedirs(dst)
            for path in glob.glob(os.path.join(src, "*")):
                name = os.path.basename(path)
                if name.endswith((".wire.jsonl", ".timeline.json")) or ".wire." in name or os.path.isdir(path):
                    continue
                if name.endswith(".json") or name.endswith(".events.jsonl") or name == "session-index.sqlite3":
                    shutil.copy2(path, os.path.join(dst, name))
            copied[project] = dst
        markers = []
        for d in (-1, 0, 1):
            t = turns.get(f"{session}#{index + d}")
            if t:
                text = collapse(t[2])[:30]
                if len(text) >= 6:
                    markers.append(text)
        src_start = starts[session]
        later = [x for x in proj_starts[project] if x > src_start]
        rows.append({"sessions_dir": copied[project], "question": p["question"], "split": p["split"],
                     "time_end_ms": min(later) if later else src_start + 1, "gold_session": session,
                     "markers": markers})
    json.dump(rows, open(os.path.join(out_dir, "l0.json"), "w", encoding="utf-8"), ensure_ascii=False)

    # ---------------- L1 ----------------
    notes = []
    for line in open(NOTES, encoding="utf-8"):
        n = json.loads(line)
        if n.get("kind") != "lesson":
            continue
        notes.append({"id": n["note_id"], "project": n["project"], "session": n["session"],
                      "session_start": starts.get(n["session"], n.get("session_ts", 0)),
                      "statement": n["statement"], "tool": ""})
    lesson_notes = json.load(open(LESSON_NOTES, encoding="utf-8"))

    def failure(e, gold):
        q = e.get("query") or {}
        lines = [l for l in (q.get("error_lines") or [])] + (q.get("stdout_errors") or [])
        output = (q.get("stderr") or "").strip() or "\n".join(lines) or (e.get("error") or "").replace(" ⏎ ", "\n")
        call = e.get("call") or ""
        tool = q.get("tool") or e.get("tool") or call.split(":", 1)[0]
        body = call.split(":", 1)[1] if ":" in call else call
        command = re.sub(r"^\s*\w+=", "", body.strip())
        target = q.get("target") or ""
        return {"tool": tool, "input": json.dumps({"command": command, "path": target}, ensure_ascii=False),
                "output": output, "session_start": starts.get(e["session"], e.get("ts", 0)),
                "split": e.get("split", "neg"), "gold": gold}

    events = [failure(e, lesson_notes.get(e["lesson_id"], []))
              for e in json.load(open(os.path.join(BENCH, "events.json"), encoding="utf-8")) if not e.get("weak")]
    negatives = [failure(n, []) for n in json.load(open(os.path.join(BENCH, "negatives.json"), encoding="utf-8"))]
    for n in negatives:
        n["split"] = "neg"
    json.dump({"notes": notes, "events": events + negatives},
              open(os.path.join(out_dir, "l1.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps({"l0_probes": len(rows), "projects_copied": len(copied), "notes": len(notes),
                      "events": len(events), "negatives": len(negatives)}))


if __name__ == "__main__":
    main()
