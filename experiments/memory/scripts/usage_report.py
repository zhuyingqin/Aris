"""Does memory get used? Aggregate report over real local sessions (read-only).

Reads the durable audit rows the desktop writes since memory step 1:

* `memory_recall` (one per turn): which Session messages the per-turn recall
  block delivered (`delivered`: session_id + message_index), a digest of the
  question, size and latency. The delivered text is rebuilt from the project's
  session-index.sqlite3, never from the log.
* `lesson_recall` (one per failed tool call that got past lessons).

"Used" means the turn's answer (assistant text or tool arguments) contains an
8-character fragment that is in the delivered history but in neither the
question nor anything earlier in the current session -- the model could only
have taken it from the recall block. It undercounts paraphrase and is a floor.

Lesson adoption compares, for failed tool calls, how often the next call of the
same tool in the same turn succeeds, with and without lessons attached.

Prints aggregates only; no session text leaves this machine or this process.
  python usage_report.py [--root ~/.config/SomniQ] [--since 2026-11-23] [--all-sessions] [--json out.json]
  python usage_report.py --selftest
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sqlite3
import statistics
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sessionlog import SessionLog, user_text  # noqa: E402

GRAM = 8
WORDY = re.compile(r"[0-9A-Za-z一-鿿]")


def normalize(text):
    return re.sub(r"\s+", " ", (text or "").lower()).strip()


def grams(text):
    text = normalize(text)
    out = set()
    for start in range(0, max(0, len(text) - GRAM + 1)):
        gram = text[start:start + GRAM]
        if len(WORDY.findall(gram)) >= GRAM // 2:
            out.add(gram)
    return out


def digest(text):
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()[:16]


def message_text(message):
    parts = []
    for block in message.get("blocks") or []:
        kind = block.get("type")
        if kind == "text":
            parts.append(block.get("text") or "")
        elif kind == "tool_use":
            parts.append(str(block.get("input") or ""))
        elif kind == "tool_result":
            parts.append(str(block.get("output") or ""))
    return "\n".join(parts)


def answer_text(message):
    """What the model produced: assistant text and tool arguments."""
    if message.get("role") != "assistant":
        return ""
    parts = []
    for block in message.get("blocks") or []:
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
        elif block.get("type") == "tool_use":
            parts.append(str(block.get("input") or ""))
    return "\n".join(parts)


def sessions_dirs(root):
    runtime = os.path.join(root, "desktop-runtime")
    dirs = [os.path.join(runtime, "sessions")]
    dirs += sorted(glob.glob(os.path.join(runtime, "projects", "*", "sessions")))
    return [d for d in dirs if os.path.isdir(d)]


def audit_rows(events_path, since_ms):
    rows = []
    with open(events_path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"kind":"memory_recall"' not in line and '"kind":"lesson_recall"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if (entry.get("ts") or 0) < since_ms:
                continue
            rows.append(entry)
    return rows


def delivered_text(index_db, refs):
    if not refs or not os.path.exists(index_db):
        return "", 0
    connection = sqlite3.connect(f"file:{index_db}?mode=ro", uri=True)
    texts, missing = [], 0
    try:
        for ref in refs:
            row = connection.execute(
                "SELECT content FROM messages WHERE session_id = ? AND message_index = ?",
                (ref.get("session_id"), ref.get("message_index")),
            ).fetchone()
            if row:
                texts.append(row[0])
            else:
                missing += 1
    finally:
        connection.close()
    return "\n".join(texts), missing


def turn_bounds(messages, start):
    end = start + 1
    while end < len(messages) and user_text(messages[end]) is None:
        end += 1
    return end


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def report(root, since_ms, all_sessions=False):
    out = {
        "recall_turns": 0, "recall_empty": 0, "recall_delivered": 0,
        "recall_matched_to_turn": 0, "recall_used": 0, "delivered_refs_missing": 0,
        "used_chars": [], "latency_ms": [],
        "lesson_deliveries": 0, "distinct_lessons": set(),
        "failed_calls": 0,
        "next_same_tool_ok_with_lesson": [0, 0],
        "next_same_tool_ok_without_lesson": [0, 0],
        "sessions_scanned": 0,
        "legacy_rows": 0, "legacy_empty": 0, "legacy_chars": [], "legacy_latency_ms": [],
        "session_arm": {},
        "arms": {},
    }
    for sessions_dir in sessions_dirs(root):
        index_db = os.path.join(sessions_dir, "session-index.sqlite3")
        for events_path in glob.glob(os.path.join(sessions_dir, "*.events.jsonl")):
            session_id = os.path.basename(events_path)[: -len(".events.jsonl")]
            rows = audit_rows(events_path, since_ms)
            if not rows and not all_sessions:
                continue
            out["sessions_scanned"] += 1
            log = SessionLog(sessions_dir, session_id)
            messages = log.messages
            user_positions = {}
            for position, message in enumerate(messages):
                text = user_text(message)
                if text is not None:
                    user_positions.setdefault(digest(text), []).append(position)
            lessons_by_call = {}
            for row in rows:
                payload = row.get("payload") or {}
                if row.get("kind") == "lesson_recall":
                    out["lesson_deliveries"] += 1
                    out["distinct_lessons"].update(payload.get("lessonIds") or [])
                    lessons_by_call[payload.get("toolUseId")] = True
                    continue
                if "delivered" not in payload:
                    # Written before step 1: size and latency only.
                    out["legacy_rows"] += 1
                    out["legacy_empty"] += 1 if payload.get("empty") else 0
                    if not payload.get("empty"):
                        out["legacy_chars"].append(payload.get("used_chars") or 0)
                    out["legacy_latency_ms"].append(payload.get("latency_ms") or 0)
                    continue
                out["recall_turns"] += 1
                arm_name = payload.get("placement") or "system"
                out["session_arm"].setdefault(session_id, arm_name)
                arm = out["arms"].setdefault(arm_name, {"turns": 0, "matched": 0, "used": 0})
                arm["turns"] += 1
                if not payload.get("empty"):
                    out["used_chars"].append(payload.get("used_chars") or 0)
                out["latency_ms"].append(payload.get("latency_ms") or 0)
                refs = payload.get("delivered") or []
                if payload.get("empty") or not refs:
                    out["recall_empty"] += 1
                    continue
                out["recall_delivered"] += 1
                positions = user_positions.get(payload.get("query_digest")) or []
                if not positions:
                    continue
                out["recall_matched_to_turn"] += 1
                arm["matched"] += 1
                start = positions.pop(0)
                end = turn_bounds(messages, start)
                block, missing = delivered_text(index_db, refs)
                out["delivered_refs_missing"] += missing
                known = grams(message_text(messages[start]))
                for earlier in messages[:start]:
                    known |= grams(message_text(earlier))
                only_in_block = grams(block) - known
                answer = set()
                for message in messages[start + 1:end]:
                    answer |= grams(answer_text(message))
                if only_in_block & answer:
                    out["recall_used"] += 1
                    arm["used"] += 1
            # Failed calls: does the next call of the same tool in the turn succeed?
            calls = log.calls
            for position, call in enumerate(calls):
                result = call.get("result") or {}
                if not result.get("is_error"):
                    continue
                out["failed_calls"] += 1
                end = turn_bounds(messages, call["msg"])
                follow = next((later for later in calls[position + 1:]
                               if later["name"] == call["name"] and later["msg"] < end), None)
                bucket = ("next_same_tool_ok_with_lesson" if lessons_by_call.get(call["id"])
                          else "next_same_tool_ok_without_lesson")
                if follow is not None and follow.get("result") is not None:
                    out[bucket][1] += 1
                    out[bucket][0] += 0 if follow["result"].get("is_error") else 1
    add_cache_by_arm(root, since_ms, out)
    return summarize(out)


def add_cache_by_arm(root, since_ms, out):
    """Executor cache reads per recall placement, from run-state/usage-log.jsonl.

    Most providers report cached tokens apart from `inputTokens` (cache read >
    input on most rows), so the share is read / (input + read + creation)."""
    path = os.path.join(root, "desktop-runtime", "run-state", "usage-log.jsonl")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("role") != "executor" or (row.get("createdAt") or 0) < since_ms:
                continue
            arm_name = out["session_arm"].get(row.get("sessionId"))
            if arm_name is None:
                continue
            arm = out["arms"][arm_name]
            read = row.get("cacheReadInputTokens") or 0
            total = (row.get("inputTokens") or 0) + read + (row.get("cacheCreationInputTokens") or 0)
            arm["cache_turns"] = arm.get("cache_turns", 0) + 1
            arm["cache_read"] = arm.get("cache_read", 0) + read
            arm["prompt_total"] = arm.get("prompt_total", 0) + total


def rate(part, whole):
    return None if not whole else round(100.0 * part / whole, 1)


def summarize(out):
    return {
        "sessions_scanned": out["sessions_scanned"],
        "older_recall_rows_without_refs": {
            "rows": out["legacy_rows"],
            "empty_pct": rate(out["legacy_empty"], out["legacy_rows"]),
            "mean_chars_when_sent": round(statistics.mean(out["legacy_chars"]), 1) if out["legacy_chars"] else None,
            "latency_ms_p50": percentile(out["legacy_latency_ms"], 0.5),
            "latency_ms_p95": percentile(out["legacy_latency_ms"], 0.95),
        },
        "recall": {
            "turns": out["recall_turns"],
            "empty_pct": rate(out["recall_empty"], out["recall_turns"]),
            "delivered_turns": out["recall_delivered"],
            "matched_to_question": out["recall_matched_to_turn"],
            "used_pct_of_matched": rate(out["recall_used"], out["recall_matched_to_turn"]),
            "used_turns": out["recall_used"],
            "mean_chars_when_sent": round(statistics.mean(out["used_chars"]), 1) if out["used_chars"] else None,
            "latency_ms_p50": percentile(out["latency_ms"], 0.5),
            "latency_ms_p95": percentile(out["latency_ms"], 0.95),
            "delivered_refs_gone_from_index": out["delivered_refs_missing"],
            "by_placement": {
                name: {
                    "turns": arm["turns"],
                    "used_pct_of_matched": rate(arm["used"], arm["matched"]),
                    "matched": arm["matched"],
                    "usage_turns": arm.get("cache_turns", 0),
                    "cache_read_share_pct": rate(arm.get("cache_read", 0), arm.get("prompt_total", 0)),
                }
                for name, arm in sorted(out["arms"].items())
            },
        },
        "lessons": {
            "deliveries": out["lesson_deliveries"],
            "distinct_lessons": len(out["distinct_lessons"]),
            "failed_calls_seen": out["failed_calls"],
            "next_same_tool_ok_with_lesson_pct": rate(*out["next_same_tool_ok_with_lesson"]),
            "with_lesson_n": out["next_same_tool_ok_with_lesson"][1],
            "next_same_tool_ok_without_lesson_pct": rate(*out["next_same_tool_ok_without_lesson"]),
            "without_lesson_n": out["next_same_tool_ok_without_lesson"][1],
        },
    }


def selftest():
    """Synthetic sessions: one turn uses the recalled fact, one does not."""
    root = tempfile.mkdtemp(prefix="memusage-")
    sessions = os.path.join(root, "desktop-runtime", "sessions")
    os.makedirs(sessions)
    db = sqlite3.connect(os.path.join(sessions, "session-index.sqlite3"))
    db.execute("CREATE TABLE messages(session_id TEXT, message_index INTEGER, content TEXT)")
    db.execute("INSERT INTO messages VALUES ('chat-old', 3, '决定：风机数据统一用 SCADA 十分钟粒度重采样，缺失值线性插值')")
    db.commit()
    db.close()

    def msg(role, *blocks):
        return {"role": role, "blocks": list(blocks)}

    def text(value):
        return {"type": "text", "text": value}

    q1, q2 = "上次风机数据怎么处理的？", "帮我写个摘要"
    lines = [
        {"kind": "session_reset", "ts": 10, "payload": {}},
        {"kind": "memory_recall", "ts": 11, "payload": {"empty": False, "used_chars": 80, "latency_ms": 40,
                                                         "query_digest": digest(q1),
                                                         "delivered": [{"session_id": "chat-old", "message_index": 3}]}},
        {"kind": "session_message", "ts": 12, "payload": {"index": 0, "message": msg("user", text(q1))}},
        {"kind": "session_message", "ts": 13, "payload": {"index": 1, "message": msg(
            "assistant", text("上次定的是 SCADA 十分钟粒度重采样，缺失值用线性插值。"),
            {"type": "tool_use", "id": "t1", "name": "bash", "input": "{\"command\":\"python a.py\"}"})}},
        {"kind": "session_message", "ts": 14, "payload": {"index": 2, "message": msg(
            "tool", {"type": "tool_result", "tool_use_id": "t1", "output": "UnicodeDecodeError: gbk", "is_error": True})}},
        {"kind": "lesson_recall", "ts": 14, "payload": {"toolUseId": "t1", "tool": "bash", "lessons": 1, "lessonIds": ["lesson_x"]}},
        {"kind": "session_message", "ts": 15, "payload": {"index": 3, "message": msg(
            "assistant", {"type": "tool_use", "id": "t2", "name": "bash", "input": "{\"command\":\"python a.py --enc gbk\"}"})}},
        {"kind": "session_message", "ts": 16, "payload": {"index": 4, "message": msg(
            "tool", {"type": "tool_result", "tool_use_id": "t2", "output": "ok", "is_error": False})}},
        {"kind": "memory_recall", "ts": 17, "payload": {"empty": False, "used_chars": 80, "latency_ms": 60,
                                                         "query_digest": digest(q2),
                                                         "delivered": [{"session_id": "chat-old", "message_index": 3}]}},
        {"kind": "session_message", "ts": 18, "payload": {"index": 5, "message": msg("user", text(q2))}},
        {"kind": "session_message", "ts": 19, "payload": {"index": 6, "message": msg("assistant", text("好的，这是摘要。"))}},
    ]
    run_state = os.path.join(root, "desktop-runtime", "run-state")
    os.makedirs(run_state)
    with open(os.path.join(run_state, "usage-log.jsonl"), "w", encoding="utf-8") as handle:
        handle.write(json.dumps({"role": "executor", "sessionId": "chat-now", "createdAt": 20,
                                 "inputTokens": 100, "cacheReadInputTokens": 300,
                                 "cacheCreationInputTokens": 0}) + "\n")
    with open(os.path.join(sessions, "chat-now.events.jsonl"), "w", encoding="utf-8") as handle:
        for line in lines:
            handle.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")
    result = report(root, 0)
    recall, lessons = result["recall"], result["lessons"]
    assert recall["turns"] == 2 and recall["matched_to_question"] == 2, result
    assert recall["used_turns"] == 1, result
    arm = recall["by_placement"]["system"]
    assert arm["turns"] == 2 and arm["cache_read_share_pct"] == 75.0, result
    # The second turn's answer repeats nothing from the block; and a fragment
    # already said earlier in the session would not count either.
    assert lessons["deliveries"] == 1 and lessons["with_lesson_n"] == 1, result
    assert lessons["next_same_tool_ok_with_lesson_pct"] == 100.0, result
    print("selftest ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.path.join(os.path.expanduser("~"), ".config", "SomniQ"))
    parser.add_argument("--since", help="YYYY-MM-DD; only audit rows from this day on")
    parser.add_argument("--json", help="also write the aggregates to this file")
    parser.add_argument("--all-sessions", action="store_true",
                        help="also scan sessions without audit rows (failed-call baseline from history)")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    since_ms = 0
    if args.since:
        since_ms = int(datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
    result = report(args.root, since_ms, args.all_sessions)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")


if __name__ == "__main__":
    main()
