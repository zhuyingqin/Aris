"""L3 promotion gate, offline: would "user rules" candidate cards be rare and right?

Design (memory step 4): an always-on rule is only *proposed* (the user confirms
it) when a user sentence carrying a persistence marker ("以后 / 一律 / 不要再 /
from now on / always / never ...") is said again, in another session, at
least 2 days later (bigram Jaccard >= 0.3). Gate A, the baseline, proposes every
marker sentence.

Reads the private corpus (F:/Agent/memory-exp-data/corpus.sqlite), writes the
candidates for labelling next to it, and prints aggregates only.

  python eval_promotion.py extract          # candidates + weekly volume
  python eval_promotion.py score            # precision from labels_*.jsonl
"""
import json
import os
import random
import re
import sqlite3
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sessionlog import INTERNAL_PREFIXES  # noqa: E402

DATA = r"F:\Agent\memory-exp-data"
OUT = os.path.join(DATA, "promotion")
DAY = 86_400_000
WEEK = 7 * DAY
MARKERS_ZH = ["以后", "今后", "一律", "不要再", "别再", "每次都", "永远", "总是", "务必", "记住",
              "默认", "统一用", "统一使用", "始终", "一定要", "不许", "禁止"]
MARKERS_EN = ["from now on", "always ", "never ", "don't ever", "remember to", "by default",
              "in the future", "every time"]
SPLIT = re.compile(r"[。！？!?\n；;]+|(?<=[a-z])\.\s")
CJK = re.compile(r"[一-鿿]")


def has_marker(sentence):
    low = sentence.lower()
    return any(m in sentence for m in MARKERS_ZH) or any(m in low for m in MARKERS_EN)


def bigrams(text):
    text = re.sub(r"\s+", "", text.lower())
    out = set()
    run = ""
    for ch in text:
        if CJK.match(ch):
            run += ch
        else:
            out.update(run[i:i + 2] for i in range(len(run) - 1))
            run = ""
    out.update(run[i:i + 2] for i in range(len(run) - 1))
    out.update(w for w in re.findall(r"[a-z0-9_]{3,}", text))
    return out


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def sentences(corpus):
    rows = corpus.execute(
        "SELECT t.turn_id, t.session_id, t.project, t.ts, t.user_text FROM turns t ORDER BY t.ts"
    ).fetchall()
    out = []
    for turn_id, session_id, project, ts, text in rows:
        text = (text or "").strip()
        if not text or text.startswith(INTERNAL_PREFIXES) or len(text) > 4000:
            continue
        for part in SPLIT.split(text):
            part = part.strip()
            if 6 <= len(part) <= 200:
                out.append({"turn": turn_id, "session": session_id, "project": project,
                            "ts": ts or 0, "text": part, "marker": has_marker(part)})
    return out


def extract():
    os.makedirs(OUT, exist_ok=True)
    corpus = sqlite3.connect(os.path.join(DATA, "corpus.sqlite"))
    rows = sentences(corpus)
    span_weeks = max(1.0, (max(r["ts"] for r in rows) - min(r["ts"] for r in rows if r["ts"])) / WEEK)
    for row in rows:
        row["grams"] = bigrams(row["text"])
    marked = [r for r in rows if r["marker"]]
    gate_b = []
    for a in marked:
        for b in rows:
            if b["session"] == a["session"] or b["ts"] < a["ts"] + 2 * DAY:
                continue
            similarity = jaccard(a["grams"], b["grams"])
            if similarity >= 0.3:
                gate_b.append({"text": a["text"], "again": b["text"], "project": a["project"],
                               "ts": b["ts"], "similarity": round(similarity, 2)})
                break  # one card per rule sentence
    # One card per distinct rule text.
    seen, cards = set(), []
    for card in gate_b:
        key = card["text"]
        if key not in seen:
            seen.add(key)
            cards.append(card)
    weekly_b = Counter(card["ts"] // WEEK for card in cards)
    weekly_a = Counter(r["ts"] // WEEK for r in marked)
    random.seed(7)
    sample_a = random.sample(marked, min(50, len(marked)))
    sample_b = random.sample(cards, min(50, len(cards)))
    for name, sample in (("gate_a", sample_a), ("gate_b", sample_b)):
        with open(os.path.join(OUT, f"candidates_{name}.jsonl"), "w", encoding="utf-8") as handle:
            for index, item in enumerate(sample):
                record = {"id": f"{name}-{index}", "text": item["text"]}
                if "again" in item:
                    record["again"] = item["again"]
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    summary = {
        "weeks": round(span_weeks, 1),
        "user_sentences": len(rows),
        "gate_a_marker_sentences": len(marked),
        "gate_a_per_week_mean": round(len(marked) / span_weeks, 1),
        "gate_a_per_week_max": max(weekly_a.values()) if weekly_a else 0,
        "gate_b_cards": len(cards),
        "gate_b_per_week_mean": round(len(cards) / span_weeks, 2),
        "gate_b_per_week_max": max(weekly_b.values()) if weekly_b else 0,
        "labelled_samples": {"gate_a": len(sample_a), "gate_b": len(sample_b)},
    }
    with open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


def score():
    result = {}
    for name in ("gate_a", "gate_b"):
        path = os.path.join(OUT, f"labels_{name}.jsonl")
        if not os.path.exists(path):
            continue
        labels = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
        keep = sum(1 for label in labels if label.get("rule"))
        result[name] = {"labelled": len(labels), "real_rules": keep,
                        "precision_pct": round(100 * keep / len(labels), 1) if labels else None}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    {"extract": extract, "score": score}[sys.argv[1] if len(sys.argv) > 1 else "extract"]()
