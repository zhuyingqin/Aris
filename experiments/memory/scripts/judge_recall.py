"""Blind judging of per-turn recall deliveries (memory_replay recall export).

    python -X utf8 -I judge_recall.py make   <scratch> [chunks]
    python -X utf8 -I judge_recall.py report <scratch>

make: from recall_export.json builds judge_recall_chunk_<n>.json (pid, question,
excerpt; nothing else) and judge_recall_key.json (pid -> stratum, row, hit).
Strata:
  turn_1 / turn_2   the 1st / 2nd window production would deliver on a real
                    user turn (own Session excluded, history before the turn)
  cal_right         a probe's gold window (known to hold the answer)
  cal_wrong         a probe question paired with a window delivered for a
                    different, random real turn
The judges write judge_recall_labels_<n>.json: [{"pid", "label"}] with label
useful | related | unrelated.

report: agreement on the calibration strata and the useful rate per stratum.
Private text: everything stays in the scratch directory outside the repo.
"""
import glob
import json
import os
import random
import sys

QUESTION_CHARS = 1500


def make(scratch, chunks):
    rows = json.load(open(os.path.join(scratch, "recall_export.json"), encoding="utf-8"))
    rng = random.Random(20261125)
    pairs = []
    turn_hits = []
    for row_index, row in enumerate(rows):
        for hit_index, hit in enumerate(row["hits"]):
            if row["kind"] == "turn":
                pairs.append(("turn_1" if hit_index == 0 else "turn_2", row_index, hit_index, row["question"], hit["window"]))
                turn_hits.append(hit["window"])
            elif hit["gold"]:
                pairs.append(("cal_right", row_index, hit_index, row["question"], hit["window"]))
    probes = [(i, r) for i, r in enumerate(rows) if r["kind"] == "probe"]
    for row_index, row in rng.sample(probes, 40):
        pairs.append(("cal_wrong", row_index, -1, row["question"], rng.choice(turn_hits)))
    rng.shuffle(pairs)
    key, chunk_items = [], [[] for _ in range(chunks)]
    for number, (stratum, row_index, hit_index, question, window) in enumerate(pairs):
        pid = f"r{number:04d}"
        key.append({"pid": pid, "stratum": stratum, "row": row_index, "hit": hit_index})
        chunk_items[number % chunks].append({
            "pid": pid,
            "question": question[:QUESTION_CHARS],
            "excerpt": window,
        })
    json.dump(key, open(os.path.join(scratch, "judge_recall_key.json"), "w", encoding="utf-8"), ensure_ascii=False)
    for number, items in enumerate(chunk_items):
        json.dump(items, open(os.path.join(scratch, f"judge_recall_chunk_{number}.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    counts = {}
    for item in key:
        counts[item["stratum"]] = counts.get(item["stratum"], 0) + 1
    print(json.dumps({"pairs": len(key), "chunks": chunks, "strata": counts}))


def labels_of(scratch):
    labels = {}
    for path in sorted(glob.glob(os.path.join(scratch, "judge_recall_labels_*.json"))):
        for row in json.load(open(path, encoding="utf-8")):
            labels[row["pid"]] = row["label"]
    return labels


def report(scratch):
    key = json.load(open(os.path.join(scratch, "judge_recall_key.json"), encoding="utf-8"))
    labels = labels_of(scratch)
    print(f"labelled {sum(k['pid'] in labels for k in key)}/{len(key)}")
    by = {}
    for item in key:
        if item["pid"] in labels:
            by.setdefault(item["stratum"], {}).setdefault(labels[item["pid"]], 0)
            by[item["stratum"]][labels[item["pid"]]] += 1
    for stratum in ("cal_right", "cal_wrong", "turn_1", "turn_2"):
        counts = by.get(stratum, {})
        total = sum(counts.values()) or 1
        print(f"{stratum:9} n={sum(counts.values()):3}  " + "  ".join(
            f"{label} {counts.get(label, 0):3} ({counts.get(label, 0) / total:.0%})"
            for label in ("useful", "related", "unrelated")))


if __name__ == "__main__":
    command, scratch = sys.argv[1], sys.argv[2]
    if command == "make":
        make(scratch, int(sys.argv[3]) if len(sys.argv) > 3 else 8)
    else:
        report(scratch)
