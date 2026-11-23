"""Retrieval strategies for the memory experiment tree.

Every strategy answers the same question: "given this query at this moment,
which pieces of past conversation (or stored memory) would the system
surface?"  All of them are deterministic and make zero model calls, except the
optional local reranker in `rerank.py`.

Units
  msg   one row per logical message, the production session-index row
  turn  one row per user turn (user text + assistant text + tool digest)

Strategies (name -> what it mirrors)
  prod_like   production `session_search`: CJK query -> bigram LIKE, score =
              number of matched terms, newest first on ties; one hit per
              session (crates/runtime/src/session_index.rs)
  v2_local    production `recall_local` over v2 atoms (research_memory_v2.rs)
  bm25_tri    FTS5 trigram, BM25 (char trigrams for CJK)
  bm25_bi     FTS5 unicode61 over a bigram shadow text, BM25
  rrf         reciprocal-rank fusion of bm25_tri + bm25_bi (L1 design)
"""
import json
import math
import re
import sqlite3
from collections import defaultdict

CORPUS = r"F:\Agent\memory-exp-data\corpus.sqlite"
V2_DB = r"F:\Agent\memory-exp-data\v2_snapshot.sqlite3"


def is_cjk(ch):
    o = ord(ch)
    return 0x3400 <= o <= 0x4DBF or 0x4E00 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF


RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_][A-Za-z0-9_.\-/]*")


def runs(text):
    for m in RUN.finditer(text or ""):
        s = m.group()
        yield s, is_cjk(s[0])


def bigram_tokens(text):
    out = []
    for s, cjk in runs(text):
        if cjk:
            out.extend([s] if len(s) == 1 else [s[i:i + 2] for i in range(len(s) - 1)])
        else:
            s = s.strip("._-/").lower()
            if len(s) > 1:
                out.append(s)
    return out


def trigram_terms(text):
    out = []
    for s, cjk in runs(text):
        if cjk:
            out.extend(s[i:i + 3] for i in range(len(s) - 2))
        else:
            s = s.strip("._-/").lower()
            if len(s) >= 3:
                out.append(s)
    return out


def fts_or(terms, limit=96):
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append('"' + t.replace('"', '""') + '"')
        if len(out) >= limit:
            break
    return " OR ".join(out)


def prod_cjk_terms(query):
    """Mirror of session_index.rs `cjk_search_terms`."""
    terms, run = set(), []

    def flush():
        if len(run) == 1:
            terms.add(run[0])
        else:
            for i in range(len(run) - 1):
                terms.add(run[i] + run[i + 1])
        run.clear()

    for ch in query:
        if is_cjk(ch):
            run.append(ch)
        elif run:
            flush()
    if run:
        flush()
    for term in re.split(r"[^\w]|_", query):
        if len(term) > 1 and not any(is_cjk(c) for c in term):
            terms.add(term)
    return sorted(terms)


def v2_recall_terms(value):
    """Mirror of research_memory_v2.rs `recall_terms`: split on characters that
    are neither alphanumeric (Unicode, like Rust char::is_alphanumeric) nor in
    U+4E00..U+9FFF; CJK runs stay whole (no bigrams); ASCII-lowercase; >=2 chars;
    sorted, deduped, first 12."""
    parts, cur = [], []
    for ch in value:
        if ch.isalnum() or 0x4E00 <= ord(ch) <= 0x9FFF:
            cur.append(ch)
        else:
            parts.append("".join(cur))
            cur = []
    parts.append("".join(cur))
    terms = sorted({"".join(c.lower() if c.isascii() else c for c in p.strip()) for p in parts
                    if len(p.strip()) >= 2})
    return terms[:12]


class Corpus:
    def __init__(self, path=CORPUS):
        src = sqlite3.connect(path)
        self.sessions = {r[0]: {"project": r[1], "start": r[2]} for r in src.execute(
            "SELECT session_id, project, start_ts FROM sessions")}
        self.turns = {}
        for r in src.execute("SELECT turn_id, session_id, project, turn_index, ts, msg_start, msg_end, "
                             "user_text, assistant_text, tool_digest, tool_ids, failed FROM turns"):
            self.turns[r[0]] = dict(turn_id=r[0], session=r[1], project=r[2], turn_index=r[3], ts=r[4],
                                    msg_start=r[5], msg_end=r[6], user=r[7], assistant=r[8], tools=r[9],
                                    tool_ids=json.loads(r[10]), failed=r[11])
        self.turn_of_msg = {}
        for t in self.turns.values():
            for i in range(t["msg_start"], t["msg_end"] + 1):
                self.turn_of_msg[(t["session"], i)] = t["turn_id"]
        self.turn_of_tool = {}
        for t in self.turns.values():
            for tid in t["tool_ids"]:
                self.turn_of_tool[tid] = t["turn_id"]
        self.msgs = []
        for r in src.execute("SELECT session_id, project, msg_index, role, content, ts FROM messages"):
            self.msgs.append(dict(session=r[0], project=r[1], msg_index=r[2], role=r[3], content=r[4],
                                  ts=r[5], low=r[4].lower()))
        src.close()
        self.db = sqlite3.connect(":memory:")
        self._build()

    # -- index --------------------------------------------------------
    @staticmethod
    def turn_text(t):
        return "\n".join(x for x in (t["user"], t["assistant"], t["tools"]) if x)

    def _build(self):
        db = self.db
        for unit in ("msg", "turn"):
            db.execute(f"CREATE VIRTUAL TABLE {unit}_tri USING fts5(uid UNINDEXED, project UNINDEXED, "
                       f"sts UNINDEXED, content, tokenize='trigram')")
            db.execute(f"CREATE VIRTUAL TABLE {unit}_bi USING fts5(uid UNINDEXED, project UNINDEXED, "
                       f"sts UNINDEXED, content)")
        rows = []
        for i, m in enumerate(self.msgs):
            rows.append((i, m["project"], self.sessions[m["session"]]["start"], m["content"]))
        db.executemany("INSERT INTO msg_tri VALUES(?,?,?,?)", rows)
        db.executemany("INSERT INTO msg_bi VALUES(?,?,?,?)",
                       [(a, b, c, " ".join(bigram_tokens(d))) for a, b, c, d in rows])
        rows = []
        for tid, t in self.turns.items():
            rows.append((tid, t["project"], self.sessions[t["session"]]["start"], self.turn_text(t)))
        db.executemany("INSERT INTO turn_tri VALUES(?,?,?,?)", rows)
        db.executemany("INSERT INTO turn_bi VALUES(?,?,?,?)",
                       [(a, b, c, " ".join(bigram_tokens(d))) for a, b, c, d in rows])
        db.commit()

    # -- helpers ------------------------------------------------------
    def unit_session(self, unit, uid):
        return self.msgs[uid]["session"] if unit == "msg" else self.turns[uid]["session"]

    def unit_turn(self, unit, uid):
        if unit == "turn":
            return uid
        m = self.msgs[uid]
        return self.turn_of_msg.get((m["session"], m["msg_index"]))

    def window_turns(self, msg_uid, width=5):
        """Turns covered by production's `window` neighbours around a matched message."""
        m = self.msgs[msg_uid]
        out = []
        for i in range(m["msg_index"] - width, m["msg_index"] + width + 1):
            t = self.turn_of_msg.get((m["session"], i))
            if t and t not in out:
                out.append(t)
        return out

    def unit_ts(self, unit, uid):
        if unit == "msg":
            return self.msgs[uid]["ts"]
        return self.turns[uid]["ts"]

    def _scope_sql(self, project, before_sts):
        clauses, params = [], []
        if project:
            clauses.append("project = ?")
            params.append(project)
        if before_sts is not None:
            clauses.append("CAST(sts AS INTEGER) < ?")
            params.append(before_sts)
        return ("AND " + " AND ".join(clauses)) if clauses else "", params

    # -- strategies ---------------------------------------------------
    def bm25(self, table_kind, unit, query, project=None, before_sts=None, k=20):
        terms = trigram_terms(query) if table_kind == "tri" else bigram_tokens(query)
        expr = fts_or(terms)
        if not expr:
            return []
        scope, params = self._scope_sql(project, before_sts)
        sql = (f"SELECT uid, bm25({unit}_{table_kind}) FROM {unit}_{table_kind} WHERE {unit}_{table_kind} "
               f"MATCH ? {scope} ORDER BY bm25({unit}_{table_kind}) LIMIT ?")
        rows = self.db.execute(sql, [expr] + params + [k]).fetchall()
        return [(int(u) if unit == "msg" else u, -s) for u, s in rows]

    def rrf(self, unit, query, project=None, before_sts=None, k=20, lists=("tri", "bi"), weights=None,
            half_life_days=None, now_ts=None, extra=None):
        weights = weights or {}
        fused = defaultdict(float)
        sources = [(name, self.bm25(name, unit, query, project, before_sts, k=60)) for name in lists]
        if extra:
            sources.extend(extra)
        for name, hits in sources:
            w = weights.get(name, 1.0)
            for rank, (uid, _) in enumerate(hits):
                fused[uid] += w / (60 + rank + 1)
        if half_life_days and now_ts:
            for uid in list(fused):
                age_days = max(0.0, (now_ts - self.unit_ts(unit, uid)) / 86_400_000)
                fused[uid] *= 0.5 ** (age_days / half_life_days) * 0.5 + 0.5
        return sorted(fused.items(), key=lambda kv: -kv[1])[:k]

    def prod_like(self, query, project, before_sts=None, current=None, k=8):
        """Production session_search for a CJK query (LIKE over bigrams), one hit per session.

        `current` = (session_id, msg_index): messages of the running session
        before that index are visible, as in production (index is updated at
        turn end)."""
        if not any(is_cjk(c) for c in query):
            return self.prod_fts(query, project, before_sts, current, k)
        terms = [t.lower() for t in prod_cjk_terms(query)]
        if not terms:
            return []
        scored = []
        for i, m in enumerate(self.msgs):
            if m["project"] != project:
                continue
            sts = self.sessions[m["session"]]["start"]
            visible = before_sts is None or sts < before_sts
            if current and m["session"] == current[0]:
                visible = m["msg_index"] < current[1]
            if not visible:
                continue
            score = sum(1 for t in terms if t in m["low"])
            if score:
                scored.append((score, m["ts"], m["msg_index"], i))
        scored.sort(reverse=True)
        scored = scored[: k * 8]
        out, seen = [], set()
        for score, _, _, i in scored:
            s = self.msgs[i]["session"]
            if s in seen:
                continue
            seen.add(s)
            out.append((i, float(score)))
            if len(out) >= k:
                break
        return out

    def prod_fts(self, query, project, before_sts, current, k):
        # English path: FTS5 unicode61 AND, then OR; bm25. Approximated on the
        # bigram table, whose ASCII tokens are the same words.
        words = [w for w in re.findall(r"\S+", query)]
        hits = []
        for op in (" AND ", " OR "):
            expr = op.join('"' + w.replace('"', '""') + '"' for w in words)
            if not expr:
                return []
            scope, params = self._scope_sql(project, None)
            try:
                rows = self.db.execute(
                    f"SELECT uid, bm25(msg_bi) FROM msg_bi WHERE msg_bi MATCH ? {scope} "
                    f"ORDER BY bm25(msg_bi) LIMIT ?", [expr] + params + [k * 8]).fetchall()
            except sqlite3.OperationalError:
                rows = []
            hits = []
            for u, s in rows:
                m = self.msgs[int(u)]
                sts = self.sessions[m["session"]]["start"]
                visible = before_sts is None or sts < before_sts
                if current and m["session"] == current[0]:
                    visible = m["msg_index"] < current[1]
                if visible:
                    hits.append((int(u), -s))
            if hits:
                break
        out, seen = [], set()
        for u, s in hits:
            sess = self.msgs[u]["session"]
            if sess not in seen:
                seen.add(sess)
                out.append((u, s))
        return out[:k]


class V2Atoms:
    def __init__(self, path=V2_DB):
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.atoms = []
        for r in db.execute("SELECT id, project_id, session_id, layer, kind, statement, status, source_event_ids, "
                            "created_at, expires_at, updated_at FROM memory_v2_atoms"):
            src = []
            for ev in json.loads(r[7] or "[]"):
                if ":" in ev:
                    s, i = ev.rsplit(":", 1)
                    if i.isdigit():
                        src.append((s, int(i)))
            self.atoms.append(dict(id=r[0], project=r[1], session=r[2], layer=r[3], kind=r[4],
                                   statement=r[5], status=r[6], src=src, created=r[8], expires=r[9],
                                   updated=r[10] or r[8] or ""))
        db.close()

    def recall_local(self, query, project, session=None, before_sts=None, sessions=None, k=12):
        terms = v2_recall_terms(query)
        if not terms:
            return []
        import datetime
        now_iso = (datetime.datetime.fromtimestamp(before_sts / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                   if before_sts else "9999")
        pool = []
        for a in self.atoms:
            if a["project"] != project or a["status"] != "active":
                continue
            if a["expires"] and a["expires"] <= now_iso:
                continue
            if not (a["layer"] == "r2" or (a["layer"] == "r1" and a["session"] == session)):
                continue
            if before_sts is not None and sessions is not None:
                src_start = sessions.get(a["session"], {}).get("start", 0)
                if src_start >= before_sts:
                    continue
            pool.append(a)
        # production: ORDER BY r1 first, then updated_at DESC, LIMIT 100, then score
        pool.sort(key=lambda a: a["updated"], reverse=True)
        pool.sort(key=lambda a: 0 if a["layer"] == "r1" else 1)
        pool = pool[:100]
        scored = []
        for a in pool:
            text = (a["statement"].lower() + " " + a["kind"])
            score = sum(1 for t in terms if t in text)
            if score:
                scored.append((score, a))
        scored.sort(key=lambda x: -x[0])
        return [a for _, a in scored[:k]]

    def r3(self, project):
        return [a for a in self.atoms if a["project"] == project and a["layer"] == "r3" and a["status"] == "active"]


def hit_at(ranked_turns, gold, ks=(1, 3, 5)):
    out = {}
    for k in ks:
        out[f"hit@{k}"] = int(any(t in gold for t in ranked_turns[:k]))
    rr = 0.0
    for i, t in enumerate(ranked_turns[:10]):
        if t in gold:
            rr = 1.0 / (i + 1)
            break
    out["mrr"] = rr
    return out


def dedupe_turns(units, corpus, unit):
    seen, out = set(), []
    for uid in units:
        t = corpus.unit_turn(unit, uid)
        if t and t not in seen:
            seen.add(t)
            out.append(t)
        elif t is None:
            out.append(None)
    return out


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else math.nan


class DocIndex:
    """A small FTS index over arbitrary memory items (notes, atoms...)."""

    def __init__(self, rows):
        # rows: iterable of dict(uid, project, sts, text, ...)
        self.rows = {r["uid"]: r for r in rows}
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE VIRTUAL TABLE d_tri USING fts5(uid UNINDEXED, project UNINDEXED, sts UNINDEXED, "
                        "content, tokenize='trigram')")
        self.db.execute("CREATE VIRTUAL TABLE d_bi USING fts5(uid UNINDEXED, project UNINDEXED, sts UNINDEXED, content)")
        data = [(r["uid"], r["project"], r["sts"], r["text"]) for r in self.rows.values()]
        self.db.executemany("INSERT INTO d_tri VALUES(?,?,?,?)", data)
        self.db.executemany("INSERT INTO d_bi VALUES(?,?,?,?)", [(a, b, c, " ".join(bigram_tokens(d))) for a, b, c, d in data])
        self.db.commit()

    def bm25(self, kind, query, project=None, before_sts=None, k=20, where=None):
        terms = trigram_terms(query) if kind == "tri" else bigram_tokens(query)
        expr = fts_or(terms)
        if not expr:
            return []
        clauses, params = [], []
        if project:
            clauses.append("project = ?")
            params.append(project)
        if before_sts is not None:
            clauses.append("CAST(sts AS INTEGER) < ?")
            params.append(before_sts)
        scope = ("AND " + " AND ".join(clauses)) if clauses else ""
        rows = self.db.execute(f"SELECT uid, bm25(d_{kind}) FROM d_{kind} WHERE d_{kind} MATCH ? {scope} "
                               f"ORDER BY bm25(d_{kind}) LIMIT ?", [expr] + params + [k * 4]).fetchall()
        out = [(u, -s) for u, s in rows if where is None or where(self.rows[u])]
        return out[:k]

    def rrf(self, query, project=None, before_sts=None, k=20, where=None):
        fused = defaultdict(float)
        for kind in ("tri", "bi"):
            for rank, (uid, _) in enumerate(self.bm25(kind, query, project, before_sts, 60, where)):
                fused[uid] += 1 / (60 + rank + 1)
        return sorted(fused.items(), key=lambda kv: -kv[1])[:k]
