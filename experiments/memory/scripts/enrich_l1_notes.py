"""Give each L1 replay note the failure it was written from.

The v7 notes carry only their source call id. The call's tool, full input and
error text are read back from the original session files (read-only over
~/.config/SomniQ). Writes <replay>/l1_enriched.json next to l1.json; the
output holds private text, so it stays outside the repo.

    python -I enrich_l1_notes.py F:/Agent/memory-exp-data
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_corpus import ROOT, load_json_session, replay_with_ts  # noqa: E402
from sessionlog import error_text  # noqa: E402

NOTES = r"F:\Agent\memory-l1-dataset\results\notes_v7.jsonl"


def session_entries(project, session_id):
    base = os.path.join(ROOT, project, "sessions") if project != "default" else os.path.join(
        os.path.dirname(ROOT), "sessions")
    events = os.path.join(base, session_id + ".events.jsonl")
    if os.path.exists(events):
        entries = replay_with_ts(events)
        if entries:
            return entries
    snapshot = os.path.join(base, session_id + ".json")
    return load_json_session(snapshot) if os.path.exists(snapshot) else []


def calls_of(entries):
    calls, results = {}, {}
    for message, _ in entries:
        for block in message.get("blocks") or []:
            if block.get("type") == "tool_use":
                calls[block.get("id")] = block
            elif block.get("type") == "tool_result":
                results[block.get("tool_use_id")] = block
    return calls, results


def main():
    root = sys.argv[1]
    replay = os.path.join(root, "replay")
    data = json.load(open(os.path.join(replay, "l1.json"), encoding="utf-8"))
    source_of = {}
    for line in open(NOTES, encoding="utf-8"):
        note = json.loads(line)
        if note.get("kind") == "lesson":
            source_of[note["note_id"]] = note.get("tool_use_id", "")
    cache = {}
    found = with_error = 0
    for note in data["notes"]:
        key = (note["project"], note["session"])
        if key not in cache:
            cache[key] = calls_of(session_entries(*key))
        calls, results = cache[key]
        call = calls.get(source_of.get(note["id"], ""))
        note.setdefault("input", "")
        note.setdefault("error", "")
        if not call:
            continue
        found += 1
        raw = call.get("input")
        note["tool"] = call.get("name") or ""
        note["input"] = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
        result = results.get(call.get("id")) or {}
        note["error"] = error_text(result.get("output")) if result else ""
        with_error += bool(note["error"])
    json.dump(data, open(os.path.join(replay, "l1_enriched.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps({"notes": len(data["notes"]), "source_found": found, "with_error": with_error}))


if __name__ == "__main__":
    main()
