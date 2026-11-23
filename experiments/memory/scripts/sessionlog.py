"""Read SomniQ session event logs the way the runtime replays them.

Mirrors `replay_canonical_session_events`: session_reset clears, session_message
appends, session_compaction appends an archive; logical order is every
archive's messages followed by the active messages. Read-only.
"""
import json
import os
import re

INTERNAL_PREFIXES = (
    "This session is being continued from a previous conversation that ran out of context.",
    "Continue the unfinished task from the exact point where the previous response stopped",
    "Your latest assistant message is empty",
    "Your previous response contained no visible text",
)
CJK = re.compile("[　-鿿豈-﫿＀-￯]")

SECRET_PATTERNS = [
    (re.compile(r"(?i)\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*(['\"]?)[^'\"\s]{8,}\2"), r"\1=\2[REDACTED]\2"),
    (re.compile(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._\-]{16,}"), r"\1[REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"), "[REDACTED]"),
    (re.compile(r"\b[0-9a-f]{32,}\b"), "[REDACTED-HEX]"),
]


def redact(text):
    if not isinstance(text, str):
        return text
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def est_tokens(text):
    cjk = len(CJK.findall(text))
    return cjk + round((len(text) - cjk) / 3.5) + 1


def session_time_ms(session_id):
    match = re.search(r"chat-(\d{13})-", session_id)
    return int(match.group(1)) if match else 0


def replay(events_path):
    messages, compactions = [], []
    with open(events_path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"kind":"session_' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            kind, payload = entry.get("kind"), entry.get("payload") or {}
            if kind == "session_reset":
                messages, compactions = [], []
            elif kind == "session_message" and "message" in payload:
                messages.append(payload["message"])
            elif kind == "session_compaction" and "compaction" in payload:
                compactions.append(payload["compaction"].get("messages") or [])
    return [m for record in compactions for m in record] + messages


def is_internal_user(message):
    if message.get("role") != "user":
        return False
    for block in message.get("blocks") or []:
        if block.get("type") == "text" and (block.get("text") or "").lstrip().startswith(INTERNAL_PREFIXES):
            return True
    return False


def user_text(message):
    if message.get("role") != "user" or is_internal_user(message):
        return None
    texts = [b.get("text") or "" for b in message.get("blocks") or [] if b.get("type") == "text"]
    joined = "\n".join(t for t in texts if t.strip())
    return joined or None


def error_text(output):
    text = (output or "").strip()
    if text.startswith("{"):
        try:
            envelope = json.loads(text)
            if isinstance(envelope, dict):
                parts = [str(envelope.get(k) or "") for k in ("stderr", "error", "message", "returnCodeInterpretation", "stdout")]
                text = "\n".join(p for p in parts if p.strip()) or text
        except ValueError:
            pass
    return text


def decode_input(raw):
    """Return (dict_or_None, flat_text) for a tool_use input string."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return None, str(raw)
    if isinstance(data, dict):
        flat = "\n".join(str(v) for v in data.values() if isinstance(v, (str, int, float)))
        return data, flat
    return None, str(data)


class SessionLog:
    """Logical messages plus an index of tool calls and their results."""

    def __init__(self, sessions_dir, session_id):
        self.session_id = session_id
        self.path = os.path.join(sessions_dir, session_id + ".events.jsonl")
        self.messages = replay(self.path)
        self.calls = []          # ordered tool calls
        by_id = {}
        for index, message in enumerate(self.messages):
            for block in message.get("blocks") or []:
                if block.get("type") == "tool_use":
                    data, flat = decode_input(block.get("input"))
                    call = {"id": block.get("id"), "name": block.get("name"), "msg": index,
                            "raw": block.get("input") or "", "data": data, "flat": flat,
                            "result": None}
                    by_id[call["id"]] = call
                    self.calls.append(call)
                elif block.get("type") == "tool_result":
                    call = by_id.get(block.get("tool_use_id"))
                    result = {"msg": index, "is_error": bool(block.get("is_error")),
                              "output": block.get("output") or "", "tool_name": block.get("tool_name")}
                    if call is not None:
                        call["result"] = result

    def input_matches(self, call, pattern):
        return bool(re.search(pattern, call["flat"]) or re.search(pattern, call["raw"]))
