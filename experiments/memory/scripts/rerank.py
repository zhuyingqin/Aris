"""Task B extra branches: hybrid lexical fusion and a local small-model reranker.

  raw_hybrid_rrf     RRF of message-level bigram BM25 (mapped to turns),
                     turn-level bigram BM25 and turn-level trigram BM25
  rerank_qwen3_0.6b  top-20 of raw_hybrid_rrf reranked by Qwen3-0.6B
                     (already in the local HF cache; yes/no logit, GPU)
  rerank_blend       0.5 * rerank rank + 0.5 * lexical rank (RRF)

Runs entirely on this machine. Writes results/recall_extra.json.
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eval_recall  # noqa: E402
from memlab import bigram_tokens  # noqa: E402

MODEL = "Qwen/Qwen3-0.6B"
_model = {}


def hybrid(corpus, q, proj, before_sts=None, k=20):
    fused = defaultdict(float)
    msg_hits = corpus.bm25("bi", "msg", q, proj, before_sts, k=80)
    seen, rank = set(), 0
    for u, _ in msg_hits:
        t = corpus.unit_turn("msg", u)
        if t and t not in seen:
            seen.add(t)
            fused[t] += 1 / (60 + rank + 1)
            rank += 1
    for kind in ("bi", "tri"):
        for r, (u, _) in enumerate(corpus.bm25(kind, "turn", q, proj, before_sts, k=60)):
            fused[u] += 1 / (60 + r + 1)
    return [u for u, _ in sorted(fused.items(), key=lambda kv: -kv[1])[:k]]


def snippet(corpus, turn_id, q, width=420):
    t = corpus.turns[turn_id]
    text = corpus.turn_text(t)
    qset = set(bigram_tokens(q))
    best, best_i = -1, 0
    step = 60
    for i in range(0, max(1, len(text) - width + 1), step):
        window = text[i:i + width]
        score = len(qset & set(bigram_tokens(window)))
        if score > best:
            best, best_i = score, i
    head = t["user"][:160]
    return f"[用户] {head}\n[片段] {text[best_i:best_i + width]}"


def load():
    if not _model:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        tok = AutoTokenizer.from_pretrained(MODEL, padding_side="left")
        model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16).cuda().eval()
        _model.update(tok=tok, model=model, yes=tok.convert_tokens_to_ids("yes"), no=tok.convert_tokens_to_ids("no"),
                      torch=torch)
    return _model


def score_pairs(q, docs):
    m = load()
    tok, model, torch = m["tok"], m["model"], m["torch"]
    prefix = ("<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the "
              "Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n")
    suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    instruct = "Given a user's question about an earlier research conversation, does this past conversation snippet contain the answer?"
    texts = [f"{prefix}<Instruct>: {instruct}\n<Query>: {q}\n<Document>: {d}{suffix}" for d in docs]
    scores = []
    for i in range(0, len(texts), 10):
        batch = tok(texts[i:i + 10], padding=True, truncation=True, max_length=640, return_tensors="pt").to("cuda")
        with torch.no_grad():
            logits = model(**batch).logits[:, -1, :]
        pair = torch.stack([logits[:, m["no"]], logits[:, m["yes"]]], dim=1).float()
        scores.extend(torch.log_softmax(pair, dim=1)[:, 1].exp().tolist())
    return scores


def reranked(corpus, q, proj, before_sts=None):
    cands = hybrid(corpus, q, proj, before_sts, k=20)
    if not cands:
        return []
    scores = score_pairs(q, [snippet(corpus, c, q) for c in cands])
    order = sorted(range(len(cands)), key=lambda i: -scores[i])
    return [cands[i] for i in order]


def blended(corpus, q, proj, before_sts=None):
    cands = hybrid(corpus, q, proj, before_sts, k=20)
    if not cands:
        return []
    scores = score_pairs(q, [snippet(corpus, c, q) for c in cands])
    order = sorted(range(len(cands)), key=lambda i: -scores[i])
    fused = defaultdict(float)
    for r, i in enumerate(order):
        fused[cands[i]] += 0.5 / (10 + r + 1)
    for r, c in enumerate(cands):
        fused[c] += 0.5 / (10 + r + 1)
    return [u for u, _ in sorted(fused.items(), key=lambda kv: -kv[1])]


if __name__ == "__main__":
    import json
    extra = {"raw_hybrid_rrf": lambda c, q, p, t: hybrid(c, q, p, t, k=10),
             "rerank_qwen3_0.6b": reranked, "rerank_blend": blended}
    if "--no-model" in sys.argv:
        extra = {"raw_hybrid_rrf": extra["raw_hybrid_rrf"]}
    s = eval_recall.main(extra_rankers=extra)
    for c, v in s["configs"].items():
        print(f"{c:26s} dev {v['dev']['hit@3']:.3f}  test {v['test']['hit@3']:.3f}  h5 {v['dev']['hit@5']:.2f}/{v['test']['hit@5']:.2f}")
    print(json.dumps({c: v["hit@3"] for c, v in s["subsets"]["changes_earlier"].items()}, ensure_ascii=False))
