"""Aggregate blind judgments of (failure, attached lesson) pairs.

Reads judge_key.json (pid -> stratum, written when the pairs were sampled) and
judge_labels_*.json (pid -> applies | related | unrelated) from the scratch
directory and prints aggregates only: judge agreement on the labelled pairs,
the "applies" rate per stratum, and the estimate for the old and new recall
rules weighted by each stratum's full size.

    python -X utf8 -I judge_report.py F:/Agent/memory-exp-data/scratch 673 161 766
"""
import glob
import json
import math
import os
import sys
from collections import Counter


def wilson(hits, total, z=1.96):
    if total == 0:
        return (0.0, 0.0)
    p = hits / total
    centre = (p + z * z / (2 * total)) / (1 + z * z / total)
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / (1 + z * z / total)
    return (centre - half, centre + half)


def main():
    scratch = sys.argv[1]
    sizes = {"old_only": int(sys.argv[2]), "new_only": int(sys.argv[3]), "both": int(sys.argv[4])}
    key = {item["pid"]: item["stratum"] for item in json.load(open(os.path.join(scratch, "judge_key.json"), encoding="utf-8"))}
    labels = {}
    for path in sorted(glob.glob(os.path.join(scratch, "judge_labels_*.json"))):
        for row in json.load(open(path, encoding="utf-8")):
            labels[row["pid"]] = row["label"]
    missing = [pid for pid in key if pid not in labels]
    print(f"labelled {len(labels)}/{len(key)}; missing {len(missing)}")
    by = {}
    for pid, stratum in key.items():
        if pid in labels:
            by.setdefault(stratum, Counter())[labels[pid]] += 1
    rate = {}
    for stratum in ("cal_right", "cal_wrong", "old_only", "new_only", "both"):
        counts = by.get(stratum, Counter())
        total = sum(counts.values())
        applies = counts["applies"]
        low, high = wilson(applies, total)
        rate[stratum] = applies / total if total else 0.0
        print(f"{stratum:9} n={total:3}  applies {applies:3} ({rate[stratum]:.0%}, 95% CI {low:.0%}-{high:.0%})"
              f"  related {counts['related']:3}  unrelated {counts['unrelated']:3}")
    old_pairs = sizes["both"] + sizes["old_only"]
    new_pairs = sizes["both"] + sizes["new_only"]
    old_right = rate["both"] * sizes["both"] + rate["old_only"] * sizes["old_only"]
    new_right = rate["both"] * sizes["both"] + rate["new_only"] * sizes["new_only"]
    print(f"old rules: {old_pairs} attachments, ~{old_right:.0f} apply ({old_right / old_pairs:.0%}), ~{old_pairs - old_right:.0f} do not")
    print(f"new rules: {new_pairs} attachments, ~{new_right:.0f} apply ({new_right / new_pairs:.0%}), ~{new_pairs - new_right:.0f} do not")
    print(f"removed ~{rate['old_only'] * sizes['old_only']:.0f} applying and ~{(1 - rate['old_only']) * sizes['old_only']:.0f} non-applying;"
          f" added ~{rate['new_only'] * sizes['new_only']:.0f} applying and ~{(1 - rate['new_only']) * sizes['new_only']:.0f} non-applying")


if __name__ == "__main__":
    main()
