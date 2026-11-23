"""Delivery branch: retrieve every turn, but deliver only when confident.

Confidence = share of the query's distinctive bigrams that occur in the top
hit (bigrams that appear in more than 5% of turns are ignored). For each
threshold we report:
  probe_delivered_hit  前情回顾 probes where we deliver AND the right turn is in top 3
  normal_fire_rate     share of ordinary real user turns (searching only
                       earlier sessions) where something would be delivered
Zero model calls. Writes results/trigger.json.
"""
import json
import os
import random
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from memlab import Corpus, bigram_tokens, mean  # noqa: E402

DATA = r"F:\Agent\memory-exp-data"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results", "trigger.json")


def hybrid(corpus, q, proj, before_sts=None, exclude_session=None, k=10):
    fused = defaultdict(float)
    seen, rank = set(), 0
    for u, _ in corpus.bm25("bi", "msg", q, proj, before_sts, k=80):
        t = corpus.unit_turn("msg", u)
        if t and t not in seen and corpus.turns[t]["session"] != exclude_session:
            seen.add(t)
            fused[t] += 1 / (60 + rank + 1)
            rank += 1
    for kind in ("bi", "tri"):
        r = 0
        for u, _ in corpus.bm25(kind, "turn", q, proj, before_sts, k=60):
            if corpus.turns[u]["session"] == exclude_session:
                continue
            fused[u] += 1 / (60 + r + 1)
            r += 1
    return [u for u, _ in sorted(fused.items(), key=lambda kv: -kv[1])[:k]]


def main():
    corpus = Corpus()
    df = Counter()
    for t in corpus.turns.values():
        df.update(set(bigram_tokens(corpus.turn_text(t))))
    common = {b for b, c in df.items() if c > 0.05 * len(corpus.turns)}

    def confidence(q, turn_id):
        qs = [b for b in set(bigram_tokens(q)) if b not in common]
        if not qs:
            return 0.0
        doc = set(bigram_tokens(corpus.turn_text(corpus.turns[turn_id])))
        return sum(b in doc for b in qs) / len(qs)

    probes = json.load(open(os.path.join(DATA, "probes.json"), encoding="utf-8"))
    probe_rows = []
    for p in probes:
        if p["turn_id"] not in corpus.turns:
            continue
        t = corpus.turns[p["turn_id"]]
        loose = {f"{t['session']}#{t['turn_index'] + d}" for d in (-1, 0, 1)}
        ranked = hybrid(corpus, p["question"], p["project"])
        probe_rows.append({"hit3": int(any(r in loose for r in ranked[:3])),
                           "conf": confidence(p["question"], ranked[0]) if ranked else 0.0})

    random.seed(11)
    later = [t for t in corpus.turns.values()
             if any(s["project"] == t["project"] and s["start"] < corpus.sessions[t["session"]]["start"]
                    for s in corpus.sessions.values()) and len(t["user"]) >= 4]
    sample = random.sample(later, min(300, len(later)))
    normal = []
    for t in sample:
        sts = corpus.sessions[t["session"]]["start"]
        ranked = hybrid(corpus, t["user"][:300], t["project"], before_sts=sts, exclude_session=t["session"])
        normal.append(confidence(t["user"][:300], ranked[0]) if ranked else 0.0)

    # semantic gate: local reranker probability that a top-3 hit answers the query
    import rerank
    for row, p in zip(probe_rows, [p for p in probes if p["turn_id"] in corpus.turns]):
        ranked = hybrid(corpus, p["question"], p["project"])[:3]
        row["sem"] = max(rerank.score_pairs(p["question"], [rerank.snippet(corpus, r, p["question"]) for r in ranked])) if ranked else 0.0
    normal_sem = []
    for t in sample:
        sts = corpus.sessions[t["session"]]["start"]
        q = t["user"][:300]
        ranked = hybrid(corpus, q, t["project"], before_sts=sts, exclude_session=t["session"])[:3]
        normal_sem.append(max(rerank.score_pairs(q, [rerank.snippet(corpus, r, q) for r in ranked])) if ranked else 0.0)
    sem_table = []
    for th in (0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        sem_table.append({"threshold": th,
                          "probe_delivered_hit": round(mean(r["hit3"] and r["sem"] >= th for r in probe_rows), 3),
                          "probe_fire": round(mean(r["sem"] >= th for r in probe_rows), 3),
                          "normal_fire_rate": round(mean(c >= th for c in normal_sem), 3)})

    table = []
    for th in (0.0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8):
        table.append({"threshold": th,
                      "probe_delivered_hit": round(mean(r["hit3"] and r["conf"] >= th for r in probe_rows), 3),
                      "normal_fire_rate": round(mean(c >= th for c in normal), 3)})
    summary = {"n_probes": len(probe_rows), "n_normal_turns": len(normal), "lexical_gate": table,
               "semantic_gate_qwen3_0.6b": sem_table}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
