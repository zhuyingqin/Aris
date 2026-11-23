"""前情回顾 probes split by query language: pure Chinese vs containing Latin
identifiers. Compares turn-level bigram vs trigram BM25 (all 132 probes,
dev+test). Writes results/query_mix.json."""
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from memlab import Corpus, hit_at, mean, runs  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results", "query_mix.json")


def main():
    corpus = Corpus()
    probes = json.load(open(r"F:\Agent\memory-exp-data\probes.json", encoding="utf-8"))
    buckets = defaultdict(lambda: defaultdict(list))
    starts = defaultdict(list)
    for meta in corpus.sessions.values():
        starts[meta["project"]].append(meta["start"])
    for p in probes:
        if p["turn_id"] not in corpus.turns:
            continue
        t = corpus.turns[p["turn_id"]]
        loose = {f"{t['session']}#{t['turn_index'] + d}" for d in (-1, 0, 1)}
        src = corpus.sessions[t["session"]]["start"]
        T = min([x for x in starts[p["project"]] if x > src] or [src + 1])
        key = "mixed" if any(not cjk for _, cjk in runs(p["question"])) else "pure_chinese"
        for kind in ("bi", "tri"):
            hits = corpus.bm25(kind, "turn", p["question"], p["project"], T, k=10)
            buckets[key][kind].append(hit_at([u for u, _ in hits], loose)["hit@3"])
    out = {k: {"n": len(v["bi"]), "bigram_hit@3": round(mean(v["bi"]), 3), "trigram_hit@3": round(mean(v["tri"]), 3)}
           for k, v in buckets.items()}
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
