"""Build the offline memory-experiment corpus from local SomniQ sessions.

Read-only over ~/.config/SomniQ. Writes one SQLite file OUTSIDE the repo
(default F:/Agent/memory-exp-data/corpus.sqlite) because it holds private
conversation text.

Tables
  sessions(session_id, project, start_ts, n_msgs, n_turns, source)
  messages(session_id, project, msg_index, role, content, ts)
      -- mirrors the production session index row (`searchable_message_text`)
  turns(turn_id, session_id, project, turn_index, ts, msg_start, msg_end,
        user_text, assistant_text, tool_digest, tool_ids, failed)
      -- one row per real user turn; the unit for the new retrieval branches

Usage: python -I build_corpus.py [--out PATH]
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sessionlog import INTERNAL_PREFIXES, error_text, redact  # noqa: E402

ROOT = os.path.join(os.path.expanduser("~"), ".config", "SomniQ", "desktop-runtime", "projects")
EXCLUDED_PROJECTS = {"project-0123456789abcdef"}  # test residue (373+ fake sessions)
SESSION_ID = re.compile(r"^(chat-(\d{13})-[a-z0-9]+)")


def replay_with_ts(path):
    """Same logic as sessionlog.replay, but keeps an event timestamp per message."""
    messages, compactions = [], []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"kind":"session_' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            kind, payload, ts = entry.get("kind"), entry.get("payload") or {}, entry.get("ts") or 0
            if kind == "session_reset":
                messages, compactions = [], []
            elif kind == "session_message" and "message" in payload:
                messages.append((payload["message"], ts))
            elif kind == "session_compaction" and "compaction" in payload:
                archived = payload["compaction"].get("messages") or []
                compactions.append([(m, ts) for m in archived])
    return [m for record in compactions for m in record] + messages


def load_json_session(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return []
    return [(m, 0) for m in data.get("messages") or []]


def is_internal(text):
    return text.lstrip().startswith(INTERNAL_PREFIXES)


def searchable_text(message):
    """Mirror of session_index.rs `searchable_message_text`."""
    parts = []
    for block in message.get("blocks") or []:
        kind = block.get("type")
        if kind == "text":
            parts.append(block.get("text") or "")
        elif kind == "tool_use":
            raw = block.get("input")
            parts.append(f"tool {block.get('name')}: {raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)}")
        elif kind == "tool_result":
            parts.append(f"tool result {block.get('tool_name')}: {block.get('output') or ''}")
    return "\n".join(parts)


def short(text, limit):
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    return text[:head] + " … " + text[-(limit - head - 3):]


def tool_args_digest(raw):
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return short(str(raw), 160)
    if isinstance(data, dict):
        keys = ("command", "path", "file_path", "query", "pattern", "url", "code", "action")
        picked = [str(data[k]) for k in keys if isinstance(data.get(k), (str, int, float))]
        if not picked:
            picked = [str(v) for v in data.values() if isinstance(v, (str, int, float))][:3]
        return short(" | ".join(picked), 160)
    return short(str(data), 160)


def build_turns(session_id, project, entries, start_ts):
    """Split logical messages into user turns (a real user text opens a turn)."""
    turns, current = [], None
    for index, (message, ts) in enumerate(entries):
        role = message.get("role")
        texts = [b.get("text") or "" for b in message.get("blocks") or [] if b.get("type") == "text"]
        user_text = "\n".join(t for t in texts if t.strip())
        opens = role == "user" and user_text and not is_internal(user_text)
        if opens:
            if current:
                turns.append(current)
            current = {"msg_start": index, "msg_end": index, "ts": ts or start_ts, "user": [user_text],
                       "assistant": [], "tools": [], "tool_ids": [], "failed": 0}
            continue
        if current is None:
            continue
        current["msg_end"] = index
        for block in message.get("blocks") or []:
            kind = block.get("type")
            if kind == "text" and role == "assistant" and (block.get("text") or "").strip():
                current["assistant"].append(block["text"])
            elif kind == "tool_use":
                current["tools"].append({"id": block.get("id"), "name": block.get("name"),
                                         "args": tool_args_digest(block.get("input")), "error": None})
                current["tool_ids"].append(block.get("id"))
            elif kind == "tool_result":
                for call in reversed(current["tools"]):
                    if call["id"] == block.get("tool_use_id"):
                        if block.get("is_error"):
                            call["error"] = short(error_text(block.get("output")), 300)
                            current["failed"] += 1
                        break
    if current:
        turns.append(current)
    rows = []
    for turn_index, turn in enumerate(turns):
        lines = []
        for call in turn["tools"][:40]:
            line = f"{call['name']}({call['args']})"
            if call["error"]:
                line += f" FAILED: {call['error']}"
            lines.append(line)
        assistant = "\n".join(turn["assistant"])
        rows.append({
            "turn_id": f"{session_id}#{turn_index}",
            "session_id": session_id, "project": project, "turn_index": turn_index,
            "ts": turn["ts"], "msg_start": turn["msg_start"], "msg_end": turn["msg_end"],
            "user_text": redact(short("\n".join(turn["user"]), 2000)),
            "assistant_text": redact(short(assistant, 2000)),
            "tool_digest": redact("\n".join(lines)),
            "tool_ids": json.dumps([i for i in turn["tool_ids"] if i]),
            "failed": turn["failed"],
        })
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=r"F:\Agent\memory-exp-data\corpus.sqlite")
    args = parser.parse_args()
    if os.path.exists(args.out):
        os.remove(args.out)
    db = sqlite3.connect(args.out)
    db.executescript("""
        CREATE TABLE sessions(session_id TEXT PRIMARY KEY, project TEXT, start_ts INTEGER,
                              n_msgs INTEGER, n_turns INTEGER, source TEXT);
        CREATE TABLE messages(session_id TEXT, project TEXT, msg_index INTEGER, role TEXT,
                              content TEXT, ts INTEGER, PRIMARY KEY(session_id, msg_index));
        CREATE TABLE turns(turn_id TEXT PRIMARY KEY, session_id TEXT, project TEXT, turn_index INTEGER,
                           ts INTEGER, msg_start INTEGER, msg_end INTEGER, user_text TEXT,
                           assistant_text TEXT, tool_digest TEXT, tool_ids TEXT, failed INTEGER);
    """)
    totals = {"sessions": 0, "messages": 0, "turns": 0}
    sources = [(os.path.basename(d), os.path.join(d, "sessions")) for d in sorted(glob.glob(os.path.join(ROOT, "project-*")))]
    sources.append(("default", os.path.join(os.path.dirname(ROOT), "sessions")))  # the no-project chats
    seen_sessions = set()
    for project, sessions_dir in sources:
        if project in EXCLUDED_PROJECTS:
            continue
        ids = {}
        for path in glob.glob(os.path.join(sessions_dir, "chat-*")):
            match = SESSION_ID.match(os.path.basename(path))
            if match:
                ids.setdefault(match.group(1), int(match.group(2)))
        for session_id, start_ts in sorted(ids.items(), key=lambda kv: kv[1]):
            if session_id in seen_sessions:  # a few chats exist both in a project and in default
                continue
            seen_sessions.add(session_id)
            events = os.path.join(sessions_dir, session_id + ".events.jsonl")
            snapshot = os.path.join(sessions_dir, session_id + ".json")
            entries, source = [], ""
            if os.path.exists(events):
                entries, source = replay_with_ts(events), "events"
            if not entries and os.path.exists(snapshot):
                entries, source = load_json_session(snapshot), "json"
            if not entries:
                continue
            turns = build_turns(session_id, project, entries, start_ts)
            if not turns:
                continue
            for index, (message, ts) in enumerate(entries):
                content = searchable_text(message)
                if content.strip():
                    db.execute("INSERT INTO messages VALUES(?,?,?,?,?,?)",
                               (session_id, project, index, message.get("role"), redact(content),
                                ts or start_ts))
                    totals["messages"] += 1
            db.executemany("INSERT INTO turns VALUES(:turn_id,:session_id,:project,:turn_index,:ts,:msg_start,"
                           ":msg_end,:user_text,:assistant_text,:tool_digest,:tool_ids,:failed)", turns)
            db.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?)",
                       (session_id, project, start_ts, len(entries), len(turns), source))
            totals["sessions"] += 1
            totals["turns"] += len(turns)
    db.commit()
    db.execute("CREATE INDEX turns_project_ts ON turns(project, ts)")
    db.execute("CREATE INDEX messages_project ON messages(project, session_id)")
    db.commit()
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
