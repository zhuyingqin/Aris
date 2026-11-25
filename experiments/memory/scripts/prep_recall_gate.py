"""Inputs for the per-turn recall gate replay (memory_replay recall).

Two kinds of items in one file, replay/recall_gate.json:
  - probe: the 132 cross-session probes of l0.json (a question that needs an
    earlier Session; gold Session + marker turns). Measures what a gate keeps.
  - turn: real user turns sampled from the corpus, searched as production does
    at that moment (history before the turn, the turn's own Session excluded).
    Unlabelled; what a gate lets through is judged blind (judge_recall.py).

Copies every needed project's sessions directory (Session JSON, event logs and
the existing index, mtimes preserved) to a scratch dir. Private text: output
stays outside the repo.

    python -X utf8 -I prep_recall_gate.py F:/Agent/memory-exp-data E:/tmp/memexp-gate 400
"""
import glob
import json
import os
import random
import shutil
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_corpus import EXCLUDED_PROJECTS  # noqa: E402
from prep_replay import sessions_dir_of  # noqa: E402


def copy_sessions(project, scratch, copied):
    if project in copied:
        return copied[project]
    src = sessions_dir_of(project)
    dst = os.path.join(scratch, project, "sessions")
    if os.path.exists(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)
    for path in glob.glob(os.path.join(src, "*")):
        name = os.path.basename(path)
        if os.path.isdir(path) or ".wire." in name or name.endswith(".timeline.json"):
            continue
        if name.endswith(".json") or name.endswith(".events.jsonl") or name == "session-index.sqlite3":
            shutil.copy2(path, os.path.join(dst, name))
    copied[project] = dst
    return dst


def main():
    data, scratch, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
    copied = {}
    items = []
    for probe in json.load(open(os.path.join(data, "replay", "l0.json"), encoding="utf-8")):
        project = os.path.basename(os.path.dirname(probe["sessions_dir"]))
        item = dict(probe, kind="probe", sessions_dir=copy_sessions(project, scratch, copied))
        items.append(item)
    db = sqlite3.connect(os.path.join(data, "corpus.sqlite"))
    turns = [row for row in db.execute(
        "SELECT turn_id, session_id, project, ts, user_text FROM turns WHERE ts > 0 ORDER BY turn_id")
        if row[2] not in EXCLUDED_PROJECTS and (row[4] or "").strip()]
    random.Random(20261124).shuffle(turns)
    for turn_id, session_id, project, ts, text in turns[:count]:
        items.append({
            "kind": "turn",
            "split": "turn",
            "id": turn_id,
            "sessions_dir": copy_sessions(project, scratch, copied),
            "question": text,
            "session_id": session_id,
            "time_end_ms": ts - 1,
        })
    json.dump(items, open(os.path.join(data, "replay", "recall_gate.json"), "w", encoding="utf-8"),
              ensure_ascii=False)
    print(json.dumps({"probes": sum(i["kind"] == "probe" for i in items),
                      "turns": sum(i["kind"] == "turn" for i in items), "projects_copied": len(copied)}))


if __name__ == "__main__":
    main()
