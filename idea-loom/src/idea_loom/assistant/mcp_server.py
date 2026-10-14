"""给小助手用的工具服务（MCP，标准输入输出上的 JSON-RPC）。

它自己什么都不做：每次工具调用都带着这一回合的令牌转给后端的
/internal/assistant/tools/<name>，由后端检查并执行。这样模型只能做后端允许的那几件事。

The tool server for the assistant (MCP, JSON-RPC over stdio). It does nothing by
itself: every tool call is forwarded, with this turn's token, to the backend at
/internal/assistant/tools/<name>, which validates and performs it. The model can
therefore do only the few things the backend allows.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get("IDEA_LOOM_API", "http://127.0.0.1:8767")
TOKEN = os.environ.get("IDEA_LOOM_TURN_TOKEN", "")

TOOLS = [
    {
        "name": "loom_get",
        "description": "读 idea-loom 的接口，只能 GET。path 以 /api/ 开头，例如 /api/state、/api/ideas/4.2、/api/wishes、/api/proposals。",
        "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
    {
        "name": "record_wish",
        "description": "把一条对 idea-loom 这个工具本身的改进愿望记进许愿池。同一个问题以前记过就用 seen 指向那一条，不要新开。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "一句话说清楚想要什么"},
                "kind": {"type": "string", "enum": ["unclear", "missing", "broken", "structure", "other"]},
                "stuck": {"type": "string", "description": "用户卡在哪里"},
                "suggestion": {"type": "string", "description": "建议怎么改"},
                "seen": {"type": "string", "description": "已有愿望的编号，写 wish-N；给了就是又遇到一次"},
                "note": {"type": "string", "description": "给已有愿望补一句说明"},
            },
            "required": ["title", "kind", "stuck", "suggestion"],
        },
    },
    {
        "name": "propose_idea",
        "description": "向想法池提议一条新的 idea。它只进候选，由用户决定留不留。写法必须符合想法池的规矩。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "body": {"type": "string", "description": "三行左右，用换行分开"},
                "level": {"type": "string", "description": "L1 到 L10，或 纵、造、规"},
                "threads": {"type": "array", "items": {"type": "string"}},
                "kernel": {"type": "string"},
                "why": {"type": "string"},
                "from_idea": {"type": "string", "description": "由哪一条想到的（可以不给）"},
            },
            "required": ["title", "body", "level", "why"],
        },
    },
    {
        "name": "point_at",
        "description": "在用户的页面上圈出一到五个元素。ref 用页面内容里方括号中的编号，例如 e12。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "points": {
                    "type": "array",
                    "items": {"type": "object", "properties": {"ref": {"type": "string"}, "note": {"type": "string"}}, "required": ["ref", "note"]},
                }
            },
            "required": ["points"],
        },
    },
]


def call_backend(name: str, arguments: dict) -> tuple[str, bool]:
    request = urllib.request.Request(
        f"{API}/internal/assistant/tools/{name}",
        data=json.dumps(arguments, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json", "x-assistant-turn": TOKEN},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8"), False
    except urllib.error.HTTPError as e:
        return e.read().decode("utf-8", "replace") or f"被拒绝（{e.code}）", True
    except OSError as e:
        return f"连不上 idea-loom 的后端：{e}", True


def handle(message: dict) -> dict | None:
    method, msg_id = message.get("method"), message.get("id")
    if method == "initialize":
        result = {
            "protocolVersion": message.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "loom", "version": "0.1.0"},
        }
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = message.get("params", {})
        text, is_error = call_backend(str(params.get("name", "")), params.get("arguments") or {})
        result = {"content": [{"type": "text", "text": text}], "isError": is_error}
    elif method == "ping":
        result = {}
    elif msg_id is None:
        return None  # 通知不用回 / notifications get no reply
    else:
        return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"unknown method {method}"}}
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            reply = handle(json.loads(line))
        except ValueError:
            continue
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
