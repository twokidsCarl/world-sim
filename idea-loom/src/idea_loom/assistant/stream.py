"""把 `claude -p --output-format stream-json` 的输出折成界面要的事件。

Fold the output of `claude -p --output-format stream-json` into the events the UI needs.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from ..llm import tokens_of

TOOL_PREFIX = "mcp__loom__"


def step_label(name: str, args: dict[str, Any], repo: str = "") -> str:
    """一步操作给人看的说法。 / How one step is described to a person."""
    short = name.removeprefix(TOOL_PREFIX)
    if short == "Read":
        path = str(args.get("file_path", ""))
        if repo and path.startswith(repo):
            path = os.path.relpath(path, repo)
        return f"在读 {path}" if path else "在读文件"
    if short == "Grep":
        return f"在找「{str(args.get('pattern', ''))[:40]}」"
    if short == "Glob":
        return f"在找文件 {str(args.get('pattern', ''))[:40]}"
    if short in ("Edit", "Write", "NotebookEdit"):
        path = str(args.get("file_path") or args.get("notebook_path") or "")
        if repo and path.startswith(repo):
            path = os.path.relpath(path, repo)
        return f"在{'写' if short == 'Write' else '改'} {path}" if path else "在改文件"
    if short == "Bash":
        return f"在跑 {str(args.get('command', ''))[:80]}"
    if short in ("Agent", "Task"):
        return f"派了一个子 Agent：{str(args.get('description', ''))[:60]}"
    if short in ("WebSearch", "WebFetch"):
        return f"在上网查 {str(args.get('query') or args.get('url') or '')[:60]}"
    if short == "loom_get":
        return f"在查 {str(args.get('path', ''))[:60]}"
    return {"record_wish": "在记愿望", "propose_idea": "在写一条候选", "point_at": "在页面上指给你看"}.get(short, f"在用 {short}")


class StreamParser:
    """一行一行地喂，吐出事件（不带序号）。 / Feed it line by line; it yields events (without seq)."""

    def __init__(self, repo: str = "") -> None:
        self.repo = repo
        self.text = ""
        self.steps: dict[str, str] = {}
        self.result: Optional[dict[str, Any]] = None

    def feed(self, obj: dict[str, Any]) -> list[dict[str, Any]]:
        kind = obj.get("type")
        if kind == "stream_event":
            event = obj.get("event") or {}
            if event.get("type") == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    self.text += delta["text"]
                    return [{"type": "text", "delta": delta["text"]}]
            return []
        if kind == "assistant":
            out = []
            for block in (obj.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use" and block.get("id") not in self.steps:
                    label = step_label(str(block.get("name", "")), block.get("input") or {}, self.repo)
                    self.steps[block["id"]] = label
                    out.append({"type": "step", "id": block["id"], "label": label, "state": "running"})
            return out
        if kind == "user":
            out = []
            content = (obj.get("message") or {}).get("content")
            for block in content if isinstance(content, list) else []:
                if block.get("type") == "tool_result" and block.get("tool_use_id") in self.steps:
                    step_id = block["tool_use_id"]
                    out.append({"type": "step", "id": step_id, "label": self.steps[step_id], "state": "refused" if block.get("is_error") else "done"})
            return out
        if kind == "result":
            self.result = obj
        return []

    def final(self) -> dict[str, Any]:
        """结束事件：答完了，或者失败了。 / The closing event: done, or failed."""
        r = self.result
        if r is None:
            return {"type": "failed", "message": "模型没有答完就断了"}
        if r.get("is_error"):
            return {"type": "failed", "message": str(r.get("result") or r.get("subtype") or "模型报错")[:300]}
        usage = r.get("usage") if isinstance(r.get("usage"), dict) else {}
        return {
            "type": "done",
            "text": self.text or str(r.get("result") or ""),
            "cost_usd": r.get("total_cost_usd"),
            "output_tokens": usage.get("output_tokens"),
            "tokens": tokens_of(r),  # 输入、输出、缓存四项 / input, output and the two cache counts
            "steps": len(self.steps),
        }
