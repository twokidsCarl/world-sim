"""操作轨迹：你在界面里换了哪一页、点了什么、停了多久。只存本机，不进 git，不记输入的文字。

The action trail: which page you went to, what you clicked, how long you stayed.
Kept on this machine only, never in git, and never including typed text.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from . import llm, store

Kind = Literal["navigate", "filter", "click", "error", "ask", "dwell", "op", "play", "like", "unlike"]


class Action(BaseModel):
    at: str
    kind: Kind
    url: str = ""
    text: str = Field(default="", max_length=160)
    seconds: float = 0  # 只有 dwell 用：在这一页前台且有操作的时长 / dwell only: active foreground time on the page
    idea: str = ""  # 这一页是哪条 idea 的页面 / the idea this page belongs to, if any
    user: str = ""  # 谁的操作；空的是主人 / whose action; empty means the owner
    card: str = ""  # play 页的卡片：<项目>/<卡片编号> / a card on the play page: <project>/<card id>


def path() -> Path:
    return llm.runs_dir() / "trail.jsonl"


def append(actions: list[Action]) -> int:
    return store.append(path(), [a.model_dump() for a in actions[:200]])


def load(user: str = "") -> list[dict[str, Any]]:
    """某个人的操作，默认是主人的。统计、推荐顺序、回看都只看一个人的。

    One person's actions, the owner's by default. Statistics, the feed order and reviews each look at one person only.
    """
    return [row for row in store.read_lines(path())[0] if str(row.get("user") or "") == user]


class CardHistory(BaseModel):
    """一张卡片被看过的情况，推荐顺序靠它。 / How a card has been watched; the feed order relies on it."""

    views: int = 0
    seconds: float = 0
    quick_skips: int = 0  # 进来不到几秒就划走的次数 / times it was left within a few seconds
    liked: bool = False
    last_at: str = ""


QUICK_SKIP_SECONDS = 5.0


def card_history(actions: list[dict[str, Any]] | None = None, user: str = "") -> dict[str, CardHistory]:
    out: dict[str, CardHistory] = {}
    for a in actions if actions is not None else load(user):
        key, kind = str(a.get("card") or ""), a.get("kind")
        if not key or kind not in ("play", "like", "unlike"):
            continue
        h = out.setdefault(key, CardHistory())
        h.last_at = max(h.last_at, str(a.get("at", "")))
        if kind == "like":
            h.liked = True
        elif kind == "unlike":
            h.liked = False
        else:
            seconds = float(a.get("seconds") or 0)
            h.views += 1
            h.seconds = round(h.seconds + seconds, 1)
            if seconds < QUICK_SKIP_SECONDS:
                h.quick_skips += 1
    return out
