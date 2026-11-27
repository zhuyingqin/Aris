"""Held-out failures for the L1 recall replay.

Collects real failed tool calls (is_error results) from every local session
(projects and the no-project chats), skips the calls the benchmark labelled,
drops repeats of the same tool + error opening, and appends them to
l1_enriched.json as split "neg_random". Unlabelled: the lessons the replay
attaches to them are judged blind, and judge_report.py aggregates the labels.
Read-only over ~/.config/SomniQ; output stays outside the repo.

    python -X utf8 -I sample_failures.py F:/Agent/memory-exp-data [count|all]
"""
import glob
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_corpus import EXCLUDED_PROJECTS, ROOT, SESSION_ID  # noqa: E402
from enrich_l1_notes import calls_of, session_entries  # noqa: E402
from sessionlog import error_text  # noqa: E402

BENCH = r"F:\Agent\memory-l1-dataset\benchmark"


def sources():
    for project_dir in sorted(glob.glob(os.path.join(ROOT, "project-*"))):
        project = os.path.basename(project_dir)
        if project not in EXCLUDED_PROJECTS:
            yield project, os.path.join(project_dir, "sessions")
    yield "default", os.path.join(os.path.dirname(ROOT), "sessions")


def repeat_key(tool, output):
    opening = re.sub(r"\d+", "#", " ".join(output.split())[:160].lower())
    return tool + "|" + opening


def main():
    root, count = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "all"
    path = os.path.join(root, "replay", "l1_enriched.json")
    data = json.load(open(path, encoding="utf-8"))
    data["events"] = [event for event in data["events"] if event["split"] != "neg_random"]
    labelled = set()
    for name in ("events.json", "negatives.json"):
        for item in json.load(open(os.path.join(BENCH, name), encoding="utf-8")):
            labelled.add(item.get("tool_use_id"))
    pool, seen_keys, seen_sessions = [], set(), set()
    for project, sessions_dir in sources():
        starts = {}
        for file in glob.glob(os.path.join(sessions_dir, "chat-*")):
            match = SESSION_ID.match(os.path.basename(file))
            if match:
                starts[match.group(1)] = int(match.group(2))
        for session_id, start in sorted(starts.items(), key=lambda item: item[1]):
            if session_id in seen_sessions:
                continue
            seen_sessions.add(session_id)
            calls, results = calls_of(session_entries(project, session_id))
            for call_id, result in results.items():
                call = calls.get(call_id)
                if not call or not result.get("is_error") or call_id in labelled:
                    continue
                output = error_text(result.get("output"))
                key = repeat_key(call.get("name") or "", output)
                if not output.strip() or key in seen_keys:
                    continue
                seen_keys.add(key)
                raw = call.get("input")
                pool.append({
                    "id": call_id,
                    "tool": call.get("name") or "",
                    "input": raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False),
                    "output": output,
                    "session_start": start,
                    "split": "neg_random",
                    "gold": [],
                })
    random.Random(20261124).shuffle(pool)
    chosen = pool if count == "all" else pool[: int(count)]
    data["events"].extend(chosen)
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps({"pool": len(pool), "added": len(chosen)}))


if __name__ == "__main__":
    main()
