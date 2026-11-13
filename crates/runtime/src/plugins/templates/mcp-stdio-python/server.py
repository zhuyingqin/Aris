"""A stdio MCP server for a SomniQ plugin, using only the Python standard library.

SomniQ starts this file with the command in cordis.patch.yml. Every line on
stdin is one JSON-RPC message and every reply is one line on stdout. Write
diagnostics to stderr only: anything else printed to stdout breaks the
protocol. The working directory is the project.

To add a tool, write a function that takes the arguments dict and returns
text, then add an entry to TOOLS with a description and a JSON Schema.
"""

import json
import sys

SERVER_NAME = "example"
SERVER_VERSION = "0.1.0"


def ping(arguments):
    return "pong"


TOOLS = {
    "ping": {
        "description": "Check that this plugin's MCP server is running. Returns pong.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "handler": ping,
    },
}


def result(request_id, value):
    return {"jsonrpc": "2.0", "id": request_id, "result": value}


def error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle(message):
    request_id = message.get("id")
    if request_id is None:
        # Notifications such as notifications/initialized need no reply.
        return None
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return result(
            request_id,
            {
                "protocolVersion": params.get("protocolVersion", "2025-03-26"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )
    if method == "ping":
        return result(request_id, {})
    if method == "tools/list":
        tools = [
            {"name": name, "description": tool["description"], "inputSchema": tool["inputSchema"]}
            for name, tool in TOOLS.items()
        ]
        return result(request_id, {"tools": tools})
    if method == "tools/call":
        name = params.get("name")
        tool = TOOLS.get(name)
        if tool is None:
            return error(request_id, -32602, f"Unknown tool: {name}")
        try:
            text = tool["handler"](params.get("arguments") or {})
        except Exception as exc:  # Report the failure to the agent instead of crashing.
            return result(
                request_id,
                {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}], "isError": True},
            )
        return result(request_id, {"content": [{"type": "text", "text": str(text)}], "isError": False})
    return error(request_id, -32601, f"Method not found: {method}")


def main():
    for raw in iter(sys.stdin.buffer.readline, b""):
        line = raw.decode("utf-8").strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"invalid JSON-RPC line: {exc}", file=sys.stderr, flush=True)
            continue
        reply = handle(message)
        if reply is not None:
            # ensure_ascii keeps stdout ASCII whatever the console code page is.
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
