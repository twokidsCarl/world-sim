"""验收：真的拿一个 Agent 来试。

起一个**看不到仓库、只配了这个 MCP 服务**的 claude，给它几个固定的任务，看它能不能只靠
工具做出来。记下每个任务调了哪些工具、有几次出错。走了弯路，说明工具的说明或错误提示
要改——这是这一层好不好用的唯一可靠的检验。它会真的调用模型，所以只在主人手动运行时跑。

Acceptance: try it with a real agent. A claude that **cannot see the repository and has only
this MCP server** is given a few fixed tasks, to see whether it can do them with the tools
alone. Which tools each task called, and how many calls failed, are recorded. A detour means
a tool description or an error hint needs work — the only reliable test of whether this
layer is usable. It really calls the model, so it only runs when the owner starts it by hand.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from typing import Any

from .. import llm

TASKS: list[tuple[str, str, list[str]]] = [
    # （编号，任务，答案里应该出现的词之一组）/ (id, task, words the answer should contain)
    ("rumour", "这里有哪些和\"谣言传播\"有关的 idea 和模拟项目？列出 idea 的编号。", ["polis"]),
    ("empty-fort", "在 mindloop 里跑《空城计》，双方各猜三层，司马懿最后怎么选？", ["司马懿"]),
    ("biceps", "肱二头肌长头（右侧）由哪条神经支配？给出数据的来源，并说明这条数据核对过没有。", ["肌皮神经", "unreviewed"]),
    ("trust", "polis 的语料里有哪些量化的事实？挑一条，说出它的数值、单位，以及它的注意事项里最要紧的一点。", ["%"]),
    ("propose", "你觉得这个想法池里缺什么？用工具提一条 idea。如果提不了，说明原因。", []),
]


def run_task(task: str, url: str, token: str = "", model: str = "sonnet", limit: int = 300) -> dict[str, Any]:
    binary = llm.claude_bin()
    if binary is None:
        raise RuntimeError("找不到 claude 命令")
    server = {"command": sys.executable, "args": ["-m", "idea_loom.cli", "mcp", "--url", url, *(["--token", token] if token else [])]}
    argv = [binary, "-p", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", "", "--allowedTools", "mcp__world-sim",
            "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": {"world-sim": server}}),
            "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence"]
    # 在一个空目录里跑：它看不到仓库，只有工具。 / Run in an empty directory: it cannot see the repository, only the tools.
    with tempfile.TemporaryDirectory() as empty:
        proc = subprocess.run(argv, input=task.encode("utf-8"), capture_output=True, cwd=empty, timeout=limit)
    calls: list[dict[str, Any]] = []
    errors = 0
    answer, cost = "", 0.0
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                calls.append({"tool": str(block.get("name", "")).replace("mcp__world-sim__", ""), "input": block.get("input")})
            if block.get("type") == "tool_result" and block.get("is_error"):
                errors += 1
        if obj.get("type") == "result":
            answer, cost = str(obj.get("result") or ""), float(obj.get("total_cost_usd") or 0)
    return {"calls": calls, "errors": errors, "answer": answer, "cost_usd": round(cost, 4)}


def run_all(url: str, token: str = "", model: str = "sonnet", only: str = "") -> list[dict[str, Any]]:
    out = []
    for task_id, task, expect in TASKS:
        if only and task_id != only:
            continue
        result = run_task(task, url, token, model)
        result.update({"id": task_id, "task": task, "missing": [w for w in expect if w not in result["answer"]]})
        out.append(result)
    return out
