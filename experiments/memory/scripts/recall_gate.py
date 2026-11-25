"""Which lexical evidence separates useful per-turn recall from noise.

Reads recall_export.json (memory_replay recall) and the blind labels of
judge_recall.py, and for a grid of gates prints, on real turns, how many
windows would still be delivered and what share of them the judges found
useful, and on the probes, how many gold windows survive.

A window passes when its anchor shares >= `count` query tokens that occur in
at most `share` of indexed messages, and those tokens carry >= `coverage` of
the query's IDF mass over such tokens.

    python -X utf8 -I recall_gate.py <scratch>
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from judge_recall import labels_of  # noqa: E402


def features(row, hit, share):
    total = max(row["messages"], 1)
    distinctive = {term: math.log((total + 1) / (df + 1)) for term, df in row["query_terms"] if df / total <= share}
    shared = [term for term in hit["shared"] if term in distinctive]
    mass = sum(distinctive.values()) or 1.0
    return len(shared), sum(distinctive[t] for t in shared) / mass


def main():
    scratch = sys.argv[1]
    rows = json.load(open(os.path.join(scratch, "recall_export.json"), encoding="utf-8"))
    key = json.load(open(os.path.join(scratch, "judge_recall_key.json"), encoding="utf-8"))
    labels = labels_of(scratch)
    judged = {(item["row"], item["hit"]): labels.get(item["pid"]) for item in key if item["hit"] >= 0}
    turn_pairs = [(rows[r], rows[r]["hits"][h], label) for (r, h), label in judged.items()
                  if rows[r]["kind"] == "turn" and label]
    probe_gold = [(row, hit) for row in rows if row["kind"] == "probe" for hit in row["hits"] if hit["gold"]]
    turns = sum(row["kind"] == "turn" for row in rows)
    base_useful = sum(label == "useful" for _, _, label in turn_pairs)
    print(f"no gate: {len(turn_pairs)} windows on {turns} turns, useful {base_useful} "
          f"({base_useful / max(len(turn_pairs), 1):.0%}); probe gold windows {len(probe_gold)}")
    results = []
    for share in (0.002, 0.005, 0.01, 0.02, 0.05):
        for count in (1, 2, 3, 4, 5, 6):
            for coverage in (0.0, 0.2, 0.3, 0.4, 0.5, 0.6):
                passed = [(label, row["id"]) for row, hit, label in turn_pairs
                          if (lambda f: f[0] >= count and f[1] >= coverage)(features(row, hit, share))]
                useful = sum(label == "useful" for label, _ in passed)
                gold = sum(1 for row, hit in probe_gold
                           if (lambda f: f[0] >= count and f[1] >= coverage)(features(row, hit, share)))
                results.append((share, count, coverage, len(passed), len({t for _, t in passed}), useful, gold))
    print("share count cover | windows turns useful precision | probe gold kept")
    for share, count, coverage, windows, turned, useful, gold in sorted(
            results, key=lambda r: (-(r[5] / r[3]) if r[3] else 0, -r[5])):
        if windows < 10:
            continue
        print(f"{share:5} {count:5} {coverage:5} | {windows:7} {turned:5} {useful:6} {useful / windows:9.0%} | {gold:3}")


if __name__ == "__main__":
    main()
