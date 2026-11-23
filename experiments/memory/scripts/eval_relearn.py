"""Task A - 踩坑重现 (re-learning): when the agent hits a failure it has already
solved in an earlier session, does the memory system surface that earlier
solution?

Benchmark: F:/Agent/memory-l1-dataset/benchmark (107 hand/dual-judge labelled
events, 46 learning moments, 35 negatives). Gold = the turns holding the
learning moment's failing call or its fix, in sessions that started before the
event's session. Zero model calls.

Writes results/relearn.json (aggregate numbers only).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collections import defaultdict
from memlab import Corpus, DocIndex, V2Atoms, bigram_tokens, dedupe_turns, hit_at, mean  # noqa: E402

BENCH = r"F:\Agent\memory-l1-dataset\benchmark"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results", "relearn.json")


def load(name):
    with open(os.path.join(BENCH, name), encoding="utf-8") as handle:
        return json.load(handle)


def error_query(event):
    q = event.get("query") or {}
    parts = [q.get("tool") or "", q.get("target") or ""]
    lines = [l for l in (q.get("error_lines") or []) if "most recent call last" not in l][:3]
    parts.extend(lines)
    parts.extend((q.get("stdout_errors") or [])[:2])
    if not lines:
        parts.append((q.get("stderr") or q.get("error") or "")[:300])
    return " ".join(p for p in parts if p)


def informative(event):
    """Trigger gate: fire only when the failure carries more than an exit code."""
    q = event.get("query") or {}
    text = " ".join((q.get("error_lines") or []) + (q.get("stdout_errors") or []) + [q.get("stderr") or ""])
    tokens = [t for t in bigram_tokens(text) if not t.startswith("exit_code") and not t.isdigit()]
    return len(set(tokens)) >= 3


def main():
    corpus = Corpus()
    v2 = V2Atoms()
    events = [e for e in load("events.json") if not e.get("weak")]
    learning = load("learning.json")
    negatives = load("negatives.json")

    def gold_for(event):
        start = corpus.sessions.get(event["session"], {}).get("start")
        gold = set()
        for moment in learning:
            if moment["lesson_id"] != event["lesson_id"]:
                continue
            ms = corpus.sessions.get(moment["session"])
            if not ms or start is None or ms["start"] >= start:
                continue
            for tool_id in (moment.get("tool_use_id"), moment.get("fix_tool_use_id")):
                t = corpus.turn_of_tool.get(tool_id)
                if t:
                    gold.add(t)
        return gold

    configs = {
        # name: (query kind, retriever, scope)
        "root_prod_inject": ("user", "prod_inject", "project"),
        "v2_atoms_userq": ("user", "v2", "project"),
        "v2_atoms_errq": ("err", "v2", "project"),
        "raw_prod_like_errq": ("err", "prod_like", "project"),
        "raw_msg_bi_errq": ("err", "msg_bi", "project"),
        "raw_turn_bi_errq": ("err", "turn_bi", "project"),
        "raw_turn_tri_errq": ("err", "turn_tri", "project"),
        "raw_turn_rrf_errq": ("err", "turn_rrf", "project"),
        "raw_turn_rrf_errq_all": ("err", "turn_rrf", "all"),
        "raw_turn_rrf_userq": ("user", "turn_rrf", "project"),
        "raw_turn_rrf_errq_48h": ("err", "turn_rrf_48h", "project"),
    }
    per_config = {name: {"dev": [], "test": []} for name in configs}
    slots_current = []
    skipped = 0
    for event in events:
        gold = gold_for(event)
        turn_id = corpus.turn_of_tool.get(event["tool_use_id"])
        if not gold or not turn_id:
            skipped += 1
            continue
        turn = corpus.turns[turn_id]
        sts = corpus.sessions[event["session"]]["start"]
        queries = {"user": turn["user"], "err": error_query(event)}
        for name, (qkind, retriever, scope) in configs.items():
            query = queries[qkind]
            project = event["project"] if scope == "project" else None
            if retriever == "prod_inject":
                hits = corpus.prod_like(query, event["project"], before_sts=sts,
                                        current=(event["session"], turn["msg_start"]), k=8)[:2]
                # production renders each hit with `window`=5 neighbouring messages
                ranked = []
                for u, _ in hits:
                    ranked.extend(t for t in corpus.window_turns(u, 5) if t not in ranked)
                slots_current.append(sum(1 for u, _ in hits if corpus.msgs[u]["session"] == event["session"]))
                atoms = v2.recall_local(query, event["project"], session=event["session"],
                                        before_sts=sts, sessions=corpus.sessions, k=3)
                atom_turns = [corpus.turn_of_msg.get(src) for a in atoms for src in a["src"]]
                ranked = ranked + [t for t in atom_turns if t]
                result = {"hit@3": int(any(t in gold for t in ranked)), "hit@1": int(bool(ranked[:1]) and ranked[0] in gold),
                          "hit@5": int(any(t in gold for t in ranked)), "mrr": 0.0}
            elif retriever == "v2":
                atoms = v2.recall_local(query, event["project"], session=None, before_sts=sts,
                                        sessions=corpus.sessions, k=5)
                ranked = []
                for a in atoms:
                    ts = [corpus.turn_of_msg.get(src) for src in a["src"]]
                    ranked.append(next((t for t in ts if t in gold), ts[0] if ts else None))
                result = hit_at(ranked, gold)
            elif retriever == "prod_like":
                hits = corpus.prod_like(query, event["project"], before_sts=sts, k=8)
                result = hit_at(dedupe_turns([u for u, _ in hits], corpus, "msg"), gold)
            elif retriever == "msg_bi":
                hits = corpus.bm25("bi", "msg", query, project, sts, k=40)
                result = hit_at(dedupe_turns([u for u, _ in hits], corpus, "msg"), gold)
            elif retriever in ("turn_bi", "turn_tri"):
                hits = corpus.bm25(retriever.split("_")[1], "turn", query, project, sts, k=10)
                result = hit_at([u for u, _ in hits], gold)
            elif retriever == "turn_rrf":
                hits = corpus.rrf("turn", query, project, sts, k=10)
                result = hit_at([u for u, _ in hits], gold)
            elif retriever == "turn_rrf_48h":
                hits = corpus.rrf("turn", query, project, sts, k=40)
                hits = [(u, s) for u, s in hits if sts - corpus.sessions[corpus.turns[u]["session"]]["start"]
                        <= 48 * 3_600_000][:10]
                result = hit_at([u for u, _ in hits], gold)
            per_config[name][event["split"]].append(result)

    # ---- write branch: v7 补录笔记 (LLM flush notes) under the same retrievers ----
    notes = []
    with open(os.path.join(os.path.dirname(BENCH), "results", "notes_v7.jsonl"), encoding="utf-8") as handle:
        for line in handle:
            n = json.loads(line)
            start = corpus.sessions.get(n["session"], {}).get("start", n.get("session_ts", 0))
            notes.append({"uid": n["note_id"], "project": n["project"], "sts": start, "text": n["statement"],
                          "kind": n.get("kind"), "session": n["session"]})
    note_index = DocIndex(notes)
    lesson_notes = json.load(open(os.path.join(os.path.dirname(BENCH), "results", "lesson_notes_v7.json"),
                                  encoding="utf-8"))
    note_cfg = {"notes_v7_bi_errq": ("bi", "project", None), "notes_v7_rrf_errq": ("rrf", "project", None),
                "notes_v7_rrf_errq_all": ("rrf", "all", None),
                "notes_v7_lesson_rrf_errq_all": ("rrf", "all", lambda r: r["kind"] == "lesson"),
                "raw_plus_notes_rrf_errq_all": ("mix", "all", lambda r: r["kind"] == "lesson")}
    for name in note_cfg:
        per_config[name] = {"dev": [], "test": []}
    per_config["raw_turn_rrf_errq_all_loose"] = {"dev": [], "test": []}
    per_config["notes_v7_lesson_rrf_errq_all_gated"] = {"dev": [], "test": []}
    for event in events:
        gold = gold_for(event)
        if not gold or not corpus.turn_of_tool.get(event["tool_use_id"]):
            continue
        sts = corpus.sessions[event["session"]]["start"]
        gold_notes = set(lesson_notes.get(event["lesson_id"], []))
        query = error_query(event)
        for name, (kind, scope, where) in note_cfg.items():
            project = event["project"] if scope == "project" else None
            if kind == "bi":
                hits = note_index.bm25("bi", query, project, sts, 10, where)
            elif kind == "rrf":
                hits = note_index.rrf(query, project, sts, 10, where)
            else:
                nh = note_index.rrf(query, project, sts, 30, where)
                th = corpus.rrf("turn", query, project, sts, k=30)
                fused = defaultdict(float)
                for rank, (u, _) in enumerate(nh):
                    fused[("n", u)] += 1 / (60 + rank + 1)
                for rank, (u, _) in enumerate(th):
                    fused[("t", u)] += 1 / (60 + rank + 1)
                ranked = [u for u, _ in sorted(fused.items(), key=lambda kv: -kv[1])[:10]]
                marks = [("G" if ((t == "n" and u in gold_notes) or (t == "t" and u in gold)) else "x") for t, u in ranked]
                per_config[name][event["split"]].append(hit_at(marks, {"G"}))
                continue
            result = hit_at([u for u, _ in hits], gold_notes)
            per_config[name][event["split"]].append(result)
            if name == "notes_v7_lesson_rrf_errq_all":
                # delivered only if the failure passes the trigger gate
                fires = informative(event)
                per_config[name + "_gated"][event["split"]].append({m: v * fires for m, v in result.items()})
        # loose criterion for raw history: same session as a learning moment, within 2 turns
        loose = set()
        for g in gold:
            t = corpus.turns[g]
            for d in range(-2, 3):
                loose.add(f"{t['session']}#{t['turn_index'] + d}")
        hits = corpus.rrf("turn", query, None, sts, k=10)
        per_config["raw_turn_rrf_errq_all_loose"][event["split"]].append(hit_at([u for u, _ in hits], loose))

    gate = {
        "events_fire": mean(informative(e) for e in events),
        "negatives_fire": mean(informative(n) for n in negatives),
    }
    summary = {"n_events": len(events) - skipped, "skipped_no_prior_gold": skipped, "gate": gate,
               "prod_inject_slots_from_current_session": mean(slots_current) / 2 if slots_current else None,
               "configs": {}}
    for name, splits in per_config.items():
        summary["configs"][name] = {}
        for split, rows in splits.items():
            summary["configs"][name][split] = {
                "n": len(rows), **{m: round(mean(r[m] for r in rows), 3) for m in ("hit@1", "hit@3", "hit@5", "mrr")}}
    # per-event 0/1 vectors (same event order in every config) for paired comparisons
    summary["vectors"] = {name: {split: [int(r["hit@3"]) for r in rows] for split, rows in splits.items()}
                          for name, splits in per_config.items()}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
