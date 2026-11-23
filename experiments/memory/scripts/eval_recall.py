"""Task B - 前情回顾 (cross-session recall): weeks later, in a new session, the
user asks about a decision / fact / preference / result established earlier.
Does the memory system surface the turn that holds the answer?

Probes: 132 questions written by independent Claude agents from sampled real
turns (F:/Agent/memory-exp-data/probes.json, private). The writer was told to
paraphrase; median bigram overlap between question and source is 26%.
Gold = the source turn. Scope = same project (production memory is
per-project). Zero model calls (the optional reranker lives in rerank.py).

Writes results/recall.json (aggregate numbers only).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from memlab import Corpus, DocIndex, V2Atoms, dedupe_turns, hit_at, mean  # noqa: E402

DATA = r"F:\Agent\memory-exp-data"
NOTES = r"F:\Agent\memory-l1-dataset\results\notes_v7.jsonl"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results", "recall.json")


def main(extra_rankers=None):
    corpus = Corpus()
    v2 = V2Atoms()
    probes = json.load(open(os.path.join(DATA, "probes.json"), encoding="utf-8"))
    # Time lock: a probe is asked at the start of the first LATER session of the
    # same project; only sessions that started before that moment are visible.
    starts_by_project = {}
    for sid, meta in corpus.sessions.items():
        starts_by_project.setdefault(meta["project"], []).append(meta["start"])

    def ask_time(probe):
        src = corpus.sessions[corpus.turns[probe["turn_id"]]["session"]]["start"]
        later = [t for t in starts_by_project[probe["project"]] if t > src]
        return min(later) if later else src + 1

    # v7 notes, mapped back to the turn they cite (tool id, else session+turn index)
    notes = []
    with open(NOTES, encoding="utf-8") as handle:
        for line in handle:
            n = json.loads(line)
            turn = corpus.turn_of_tool.get(n.get("tool_use_id"))
            if not turn:
                turn = f"{n['session']}#{n.get('turn_index', 0)}"
            start = corpus.sessions.get(n["session"], {}).get("start", n.get("session_ts", 0))
            notes.append({"uid": n["note_id"], "project": n["project"], "sts": start, "text": n["statement"],
                          "kind": n.get("kind"), "turn": turn, "session": n["session"]})
    note_index = DocIndex(notes)
    note_turn = {n["uid"]: n["turn"] for n in notes}

    configs = ["root_prod_inject", "v2_atoms", "raw_prod_like_tool", "raw_msg_bi", "raw_turn_bi",
               "raw_turn_tri", "raw_turn_rrf", "raw_turn_rrf_recency", "raw_turn_user_only_rrf",
               "notes_v7_rrf", "notes_plus_raw_rrf"]
    if extra_rankers:
        configs += list(extra_rankers)
    per = {c: {"dev": [], "test": []} for c in configs}
    subsets = {"changes_earlier": {c: [] for c in configs}, "answer_from_user": {c: [] for c in configs}}
    coverage = {"v2_atom_exists": [], "note_exists": []}

    # user-only index for the "only keep what the user said" branch
    user_only = DocIndex([{"uid": t["turn_id"], "project": t["project"],
                           "sts": corpus.sessions[t["session"]]["start"], "text": t["user"]}
                          for t in corpus.turns.values()])

    for p in probes:
        gold_turn = p["turn_id"]
        if gold_turn not in corpus.turns:
            continue
        t = corpus.turns[gold_turn]
        gold = {gold_turn}
        loose = {f"{t['session']}#{t['turn_index'] + d}" for d in (-1, 0, 1)}
        q, proj = p["question"], p["project"]
        T = ask_time(p)
        coverage["v2_atom_exists"].append(int(any(
            a["project"] == proj and a["status"] == "active" and any(corpus.turn_of_msg.get(s) in loose for s in a["src"])
            for a in v2.atoms)))
        coverage["note_exists"].append(int(any(n["turn"] in loose for n in notes if n["project"] == proj)))
        results = {}
        hits = corpus.prod_like(q, proj, before_sts=T, k=8)[:2]
        ranked = []  # production renders each hit with `window`=5 neighbouring messages
        for u, _ in hits:
            ranked.extend(x for x in corpus.window_turns(u, 5) if x not in ranked)
        atoms = v2.recall_local(q, proj, session=None, before_sts=T, sessions=corpus.sessions, k=3)
        ranked += [corpus.turn_of_msg.get(s) for a in atoms for s in a["src"][:1]]
        results["root_prod_inject"] = {"hit@1": int(bool(ranked) and ranked[0] in loose),
                                       "hit@3": int(any(x in loose for x in ranked)),
                                       "hit@5": int(any(x in loose for x in ranked)), "mrr": 0.0}
        atoms = v2.recall_local(q, proj, session=None, before_sts=T, sessions=corpus.sessions, k=5)
        results["v2_atoms"] = hit_at([next((corpus.turn_of_msg.get(s) for s in a["src"]
                                            if corpus.turn_of_msg.get(s) in loose), None) for a in atoms], loose)
        hits = corpus.prod_like(q, proj, before_sts=T, k=8)
        results["raw_prod_like_tool"] = hit_at(dedupe_turns([u for u, _ in hits], corpus, "msg"), loose)
        hits = corpus.bm25("bi", "msg", q, proj, T, k=40)
        results["raw_msg_bi"] = hit_at(dedupe_turns([u for u, _ in hits], corpus, "msg"), loose)
        for kind in ("bi", "tri"):
            hits = corpus.bm25(kind, "turn", q, proj, T, k=10)
            results[f"raw_turn_{kind}"] = hit_at([u for u, _ in hits], loose)
        hits = corpus.rrf("turn", q, proj, T, k=10)
        results["raw_turn_rrf"] = hit_at([u for u, _ in hits], loose)
        hits = corpus.rrf("turn", q, proj, T, k=10, half_life_days=30, now_ts=T)
        results["raw_turn_rrf_recency"] = hit_at([u for u, _ in hits], loose)
        hits = user_only.rrf(q, proj, T, k=10)
        results["raw_turn_user_only_rrf"] = hit_at([u for u, _ in hits], loose)
        hits = note_index.rrf(q, proj, T, k=10)
        results["notes_v7_rrf"] = hit_at([note_turn[u] for u, _ in hits], loose)
        from collections import defaultdict
        fused = defaultdict(float)
        for rank, (u, _) in enumerate(note_index.rrf(q, proj, T, k=30)):
            fused[note_turn[u]] += 1 / (60 + rank + 1)
        for rank, (u, _) in enumerate(corpus.rrf("turn", q, proj, T, k=30)):
            fused[u] += 1 / (60 + rank + 1)
        results["notes_plus_raw_rrf"] = hit_at([u for u, _ in sorted(fused.items(), key=lambda kv: -kv[1])], loose)
        for name, ranker in (extra_rankers or {}).items():
            results[name] = hit_at(ranker(corpus, q, proj, T), loose)
        for c in configs:
            per[c][p["split"]].append(results[c])
            if p.get("changes_earlier") is True:
                subsets["changes_earlier"][c].append(results[c])
            if p.get("answer_from") == "user":
                subsets["answer_from_user"][c].append(results[c])

    summary = {"n_probes": len(probes), "coverage": {k: round(mean(v), 3) for k, v in coverage.items()},
               "configs": {}, "subsets": {}}
    for c in configs:
        summary["configs"][c] = {s: {"n": len(rows), **{m: round(mean(r[m] for r in rows), 3)
                                                        for m in ("hit@1", "hit@3", "hit@5", "mrr")}}
                                 for s, rows in per[c].items()}
    summary["vectors"] = {c: {s: [int(r["hit@3"]) for r in rows] for s, rows in per[c].items()} for c in configs}
    for name, by_c in subsets.items():
        summary["subsets"][name] = {c: {"n": len(rows), "hit@3": round(mean(r["hit@3"] for r in rows), 3)}
                                    for c, rows in by_c.items()}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out = OUT if not extra_rankers else OUT.replace(".json", "_extra.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    return summary


if __name__ == "__main__":
    s = main()
    print(json.dumps({"n": s["n_probes"], "coverage": s["coverage"]}, ensure_ascii=False))
    for c, v in s["configs"].items():
        print(f"{c:26s} dev {v['dev']['hit@3']:.3f}  test {v['test']['hit@3']:.3f}  h5 {v['dev']['hit@5']:.2f}/{v['test']['hit@5']:.2f}")
    print("changes_earlier:", {c: v["hit@3"] for c, v in s["subsets"]["changes_earlier"].items()})
