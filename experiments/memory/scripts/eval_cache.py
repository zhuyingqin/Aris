"""Task C - 注入代价: what does the per-turn recall block cost in prompt cache?

Joins the production `memory_recall` events (kept in session events.jsonl)
with the real per-request usage log (run-state/usage-log.jsonl). For each
user turn we compare the FIRST request of the turn (the one that sees a new
recall block) with the follow-up requests of the same turn (same block, so
the cache can hit).  Zero model calls; aggregate numbers only.
"""
import bisect
import glob
import json
import os
from collections import defaultdict

RUNTIME = os.path.join(os.path.expanduser("~"), ".config", "SomniQ", "desktop-runtime")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results", "cache.json")


def median(xs):
    xs = sorted(xs)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def main():
    usage = defaultdict(list)
    with open(os.path.join(RUNTIME, "run-state", "usage-log.jsonl"), encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                r = json.loads(line)
                if r.get("role", "executor") == "executor":
                    usage[r["sessionId"]].append(r)
    for rows in usage.values():
        rows.sort(key=lambda r: r["createdAt"])

    recalls = []
    paths = glob.glob(os.path.join(RUNTIME, "projects", "*", "sessions", "*.events.jsonl"))
    paths += glob.glob(os.path.join(RUNTIME, "sessions", "*.events.jsonl"))
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if '"kind":"memory_recall"' not in line:
                    continue
                e = json.loads(line)
                p = e["payload"]
                recalls.append({"session": e["sessionId"], "ts": e["ts"], "empty": p.get("empty"),
                                "used_chars": p.get("used_chars") or 0,
                                "r0_chars": sum(l.get("used_chars") or 0 for l in p.get("layers") or []
                                                if l.get("code") == "R0")})

    def ratio(r):
        total = (r.get("inputTokens") or 0) + (r.get("cacheReadInputTokens") or 0) + (r.get("cacheCreationInputTokens") or 0)
        return (r.get("cacheReadInputTokens") or 0) / total if total else None, total

    groups = {"block": {"first": [], "follow": [], "uncached_first": []},
              "empty": {"first": [], "follow": [], "uncached_first": []}}
    matched = 0
    for rec in recalls:
        rows = usage.get(rec["session"])
        if not rows:
            continue
        times = [r["createdAt"] * 1000 for r in rows]
        i = bisect.bisect_left(times, rec["ts"])
        if i >= len(rows) or times[i] - rec["ts"] > 15 * 60_000:
            continue
        first = rows[i]
        turn = first.get("turnId")
        follow = [r for r in rows[i + 1:i + 60] if turn and r.get("turnId") == turn]
        g = groups["empty" if rec["empty"] else "block"]
        fr, ftotal = ratio(first)
        if fr is None:
            continue
        matched += 1
        g["first"].append(fr)
        g["uncached_first"].append(first.get("inputTokens") or 0)
        for r in follow:
            rr, _ = ratio(r)
            if rr is not None:
                g["follow"].append(rr)

    summary = {
        "recall_events": len(recalls),
        "nonempty_share": round(sum(1 for r in recalls if not r["empty"]) / len(recalls), 3) if recalls else None,
        "median_injected_chars_when_nonempty": median([r["used_chars"] for r in recalls if not r["empty"]]),
        "median_r0_chars_when_nonempty": median([r["r0_chars"] for r in recalls if not r["empty"]]),
        "matched_turns": matched,
    }
    for name, g in groups.items():
        summary[name] = {
            "turns": len(g["first"]),
            "first_request_cache_ratio_median": round(median(g["first"]), 3) if g["first"] else None,
            "follow_request_cache_ratio_median": round(median(g["follow"]), 3) if g["follow"] else None,
            "first_request_uncached_tokens_median": median(g["uncached_first"]),
        }
    # Gap-matched comparison: a request that follows a new recall block (new
    # user turn) vs a request inside the same turn (block unchanged), bucketed
    # by idle time so provider cache expiry is not mistaken for the block.
    rec_by_session = defaultdict(list)
    for rec in recalls:
        rec_by_session[rec["session"]].append(rec["ts"])
    strata = defaultdict(list)
    for session, stamps in rec_by_session.items():
        rows = usage.get(session) or []
        stamps.sort()
        for a, b in zip(rows, rows[1:]):
            start_a = a["createdAt"] * 1000
            start_b = b["createdAt"] * 1000 - (b.get("durationMs") or 0)
            new_turn = any(start_a < t <= start_b + 2000 for t in stamps)
            gap = (start_b - start_a) / 1000
            r, total = ratio(b)
            if r is None or total < 2000:
                continue
            bucket = "<30s" if gap < 30 else "30s-5m" if gap < 300 else ">5m"
            strata[("new_turn" if new_turn else "same_turn") + ":" + bucket].append(r)
    summary["gap_matched_cache_ratio"] = {k: {"n": len(v), "median": round(median(v), 3)}
                                          for k, v in sorted(strata.items())}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
