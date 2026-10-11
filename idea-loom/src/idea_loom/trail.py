"""操作轨迹：你在界面里换了哪一页、点了什么、停了多久。只存本机，不进 git，不记输入的文字。

The action trail: which page you went to, what you clicked, how long you stayed.
Kept on this machine only, never in git, and never including typed text.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from . import llm, store

Kind = Literal["navigate", "filter", "click", "error", "ask", "dwell", "op"]


class Action(BaseModel):
    at: str
    kind: Kind
    url: str = ""
    text: str = Field(default="", max_length=160)
    seconds: float = 0  # 只有 dwell 用：在这一页前台且有操作的时长 / dwell only: active foreground time on the page
    idea: str = ""  # 这一页是哪条 idea 的页面 / the idea this page belongs to, if any


def path() -> Path:
    return llm.runs_dir() / "trail.jsonl"


def append(actions: list[Action]) -> int:
    return store.append(path(), [a.model_dump() for a in actions[:200]])


def load() -> list[dict[str, Any]]:
    return store.read_lines(path())[0]
