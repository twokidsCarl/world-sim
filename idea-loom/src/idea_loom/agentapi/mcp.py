"""MCP：给 Agent 的工具。一张工具表，两种接法——远程的 /mcp 和本机的标准输入输出。

工具不照搬接口，而是按 Agent 要做的事来分，数量少。每个工具的执行都是对 /api/v1 的一次
请求，所以两种接法、以及直接用 HTTP，行为必然一样。

MCP: the tools for agents. One tool table, two ways in — the remote /mcp and local stdio.
The tools do not mirror the routes; they are split by what an agent wants to do and kept few.
Each tool is carried out as one request to /api/v1, so both transports, and plain HTTP,
necessarily behave the same.
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

PROTOCOL = "2025-03-26"
SERVER = {"name": "world-sim", "version": "1.0.0"}
INSTRUCTIONS = (
    "world-sim: simulation projects from physics up to civilisation, the data they curated, and a pool of ideas. "
    "Call `catalog` first. For data: `describe_dataset`, then `query_dataset`. For computations: `describe_capability`, then `run`. "
    "Every dataset reply carries its licence and provenance; say so when you rely on it, and note when records are marked unreviewed. "
    "world-sim：从物理到文明的一组模拟、它们整理的数据和一个想法池。先调 catalog。"
)

Api = Callable[[str, str, Optional[dict[str, Any]], Optional[dict[str, Any]]], Awaitable[tuple[int, Any]]]


def _obj(properties: dict[str, Any], required: Optional[list[str]] = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}


S = {"type": "string"}
PROJECT = {"type": "string", "description": "A project name from `catalog`, e.g. soma, polis, mindloop, limn."}
TOOLS: list[dict[str, Any]] = [
    {"name": "catalog", "description": "What is here: every project with a summary, its datasets, its runnable computations and how many scenario cards it has. Call this first. / 这里有什么。先调它。",
     "inputSchema": _obj({})},
    {"name": "search_ideas", "description": "Search the idea pool: short prompts for simulations, placed on a ladder of scales (L1 matter … L10 life and planet) and tagged with threads. Returns id, title and position only, so `limit: 200` with no `q` lists the whole pool in one call; pass `full: true` for the bodies, or use `get_idea`. / 搜想法池，默认只给标题和位置。",
     "inputSchema": _obj({"q": {"type": "string", "description": "Words to look for, Chinese or English; all must match."}, "level": {"type": "string", "description": "L1…L10, or 纵, 造, 规"},
                          "thread": {"type": "string", "description": "A, B, C, D or E"}, "kernel": S, "project": S, "full": {"type": "boolean", "description": "Include the bodies (Chinese and English)."},
                          "limit": {"type": "integer", "minimum": 1, "maximum": 200}, "after": {"type": "integer", "minimum": 0}})},
    {"name": "get_idea", "description": "One idea in full: text in Chinese and English, its history, where it came from and what followed it, the projects building it and the cards that open it. / 一条 idea 的全文、历史和血缘。",
     "inputSchema": _obj({"id": {"type": "string", "description": "An idea id such as 4.2, 纵 1 or 造 3."}}, ["id"])},
    {"name": "describe_dataset", "description": "The shape of a dataset before querying it: record count, fields, key field, licence, provenance and one sample record. / 查之前先看一个数据集的结构。",
     "inputSchema": _obj({"project": PROJECT, "dataset": S}, ["project", "dataset"])},
    {"name": "query_dataset", "description": "Query a dataset. `q` searches text (all words must match); `where` filters by exact field value, e.g. [\"kind=innervatedBy\"]; `key` fetches by the key field; `fields` picks fields. Replies carry `total`, `next` (pass it as `after` for the next page), the licence and the provenance. / 查数据集。",
     "inputSchema": _obj({"project": PROJECT, "dataset": S, "q": S, "key": S, "where": {"type": "array", "items": {"type": "string", "description": "field=value"}},
                          "fields": {"type": "array", "items": S, "description": "Fields to return; [\"*\"] for all."}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}, "after": {"type": "integer", "minimum": 0}},
                         ["project", "dataset"])},
    {"name": "describe_capability", "description": "A runnable computation before running it: what it does, its input JSON Schema, what it returns and an example input that works. / 跑之前先看一个计算的输入和例子。",
     "inputSchema": _obj({"project": PROJECT, "capability": S}, ["project", "capability"])},
    {"name": "run", "description": "Run one bounded computation of a project with the given input. Deterministic unless its description says it depends on an external service. The reply states the version that computed it. / 跑一次计算。",
     "inputSchema": _obj({"project": PROJECT, "capability": S, "input": {"type": "object", "description": "The input, as described by `describe_capability`."}}, ["project", "capability", "input"])},
    {"name": "list_cards", "description": "Scenario cards: URLs a person can open in a browser to watch a simulation at a particular scenario. Filter by project or idea. / 可以让人打开看的场景地址。",
     "inputSchema": _obj({"project": S, "idea": S})},
    {"name": "propose_idea", "description": "Propose a new idea for the pool. It goes to the owner's review queue and is not added directly. Needs a token with the propose scope. Style: a title and about three short lines saying what to simulate, one concrete question, and what to look up or align with. / 提一条 idea，进待主人过目的队列。",
     "inputSchema": _obj({"title": S, "body": {"type": "string", "description": "About three short lines, separated by newlines."}, "level": {"type": "string", "description": "L1…L10, or 纵, 造, 规"},
                          "threads": {"type": "array", "items": S}, "kernel": S, "why": {"type": "string", "description": "Why the pool lacks this."}}, ["title", "body", "level", "why"])},
    {"name": "propose_wish", "description": "Tell the owner what would make this service easier for you to use: something missing, unclear or broken. It goes to the owner's review queue. Needs a token with the propose scope. / 告诉主人这里哪里不好用。",
     "inputSchema": _obj({"title": {"type": "string", "description": "One sentence: what you would like."}, "stuck": {"type": "string", "description": "Where you got stuck."}}, ["title"])},
]


def _seg(value: Any) -> str:
    return quote(str(value), safe="")


async def call(name: str, args: dict[str, Any], api: Api) -> tuple[int, Any]:
    """执行一个工具：一次对 /api/v1 的请求。 / Carry out one tool: one request to /api/v1."""
    v1 = "/api/v1"
    if name == "catalog":
        return await api("GET", f"{v1}/catalog", None, None)
    if name == "search_ideas":
        return await api("GET", f"{v1}/ideas", {k: v for k, v in args.items() if v not in (None, "")}, None)
    if name == "get_idea":
        return await api("GET", f"{v1}/ideas/{_seg(args.get('id', ''))}", None, None)
    if name == "describe_dataset":
        return await api("GET", f"{v1}/datasets/{_seg(args.get('project', ''))}/{_seg(args.get('dataset', ''))}/schema", None, None)
    if name == "query_dataset":
        params: dict[str, Any] = {k: args[k] for k in ("q", "key", "limit", "after") if args.get(k) not in (None, "")}
        if args.get("where"):
            params["where"] = list(args["where"])
        if args.get("fields"):
            params["fields"] = ",".join(args["fields"])
        return await api("GET", f"{v1}/datasets/{_seg(args.get('project', ''))}/{_seg(args.get('dataset', ''))}", params, None)
    if name == "describe_capability":
        return await api("GET", f"{v1}/capabilities/{_seg(args.get('project', ''))}/{_seg(args.get('capability', ''))}", None, None)
    if name == "run":
        return await api("POST", f"{v1}/run/{_seg(args.get('project', ''))}/{_seg(args.get('capability', ''))}", None, args.get("input") if isinstance(args.get("input"), dict) else {})
    if name == "list_cards":
        return await api("GET", f"{v1}/cards", {k: v for k, v in args.items() if v}, None)
    if name == "propose_idea":
        return await api("POST", f"{v1}/proposals/idea", None, args)
    if name == "propose_wish":
        return await api("POST", f"{v1}/proposals/wish", None, args)
    return 404, {"error": f"没有 {name!r} 这个工具", "hint": "Tools: " + ", ".join(t["name"] for t in TOOLS)}


async def handle(message: Any, api: Api) -> Optional[dict[str, Any]]:
    """处理一条 JSON-RPC 消息；通知没有回复，返回 None。 / Handle one JSON-RPC message; notifications get no reply and return None."""
    if not isinstance(message, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    method, mid = message.get("method"), message.get("id")
    if mid is None:
        return None
    if method == "initialize":
        wanted = (message.get("params") or {}).get("protocolVersion")
        return {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": wanted if isinstance(wanted, str) else PROTOCOL, "capabilities": {"tools": {}},
                                                       "serverInfo": SERVER, "instructions": INSTRUCTIONS}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            status, body = await call(str(params.get("name") or ""), args, api)
        except Exception as e:  # noqa: BLE001 — 工具出错要告诉 Agent，不能让连接断掉 / a failing tool must tell the agent, not drop the connection
            status, body = 502, {"error": f"连不上 world-sim：{e}", "hint": "Is it running? Start it with: cd idea-loom && uv run idea-loom serve"}
        text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": status >= 400}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def stdio(base: str, token: str = "") -> None:
    """本机的接法：从标准输入读 JSON-RPC，一行一条，回到标准输出。 / The local transport: JSON-RPC from stdin, one message per line, replies on stdout."""
    import asyncio
    import sys

    import httpx

    headers = {"authorization": f"Bearer {token}"} if token else {}

    async def api(method: str, path: str, params: Optional[dict[str, Any]], body: Optional[dict[str, Any]]) -> tuple[int, Any]:
        async with httpx.AsyncClient(base_url=base, timeout=130, headers=headers) as client:
            response = await client.request(method, path, params=params, json=body)
        try:
            return response.status_code, response.json()
        except ValueError:
            return response.status_code, response.text

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            reply: Optional[dict[str, Any]] = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            reply = asyncio.run(handle(message, api))
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()
