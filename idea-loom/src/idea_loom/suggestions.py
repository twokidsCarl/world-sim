"""访客提的愿望：先进一个"待主人过目"的队列，主人看过才进许愿池。

访客写的是不可信的文字。这里只存、只给主人看；它不会触发任何模型调用。主人接受之后才变成
许愿池里的一条愿望（来源记成 visitor:<用户名>），之后要不要让 Claude Code 去做、方案批不批，
仍然是主人的两道决定。这些内容不进公开的仓库。

Wishes from visitors go into a queue for the owner to look over first and only reach the
wish pool once the owner has seen them. What a visitor writes is untrusted text: it is only
stored and shown to the owner here and never triggers a model call. Only when the owner
accepts it does it become a wish in the pool (with the source recorded as visitor:<login>),
and whether Claude Code works on it, and whether its plan is approved, remain two further
decisions of the owner. None of this goes into the public repository.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel

from . import notify, store, wishes

PER_DAY = 5
MAX_TITLE, MAX_TEXT = 120, 1000
Status = Literal["waiting", "accepted", "dismissed"]


class SuggestionError(ValueError):
    """这一步做不了，原因写给人看。 / The step cannot be taken; the message is for a person."""


class Suggestion(BaseModel):
    id: str
    by: str  # 提的人的 GitHub 用户名 / the GitHub login of who sent it
    title: str
    stuck: str = ""
    where_url: str = ""
    where_title: str = ""
    status: Status = "waiting"
    wish_id: Optional[str] = None
    note: str = ""
    created_at: str
    updated_at: str


def path() -> Path:
    return store.runs_dir() / "suggestions.jsonl"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clip(text: str, limit: int) -> str:
    # 去掉控制字符：这些文字以后可能出现在给模型的材料里。 / Control characters are dropped: this text may later appear in material given to the model.
    return "".join(ch for ch in (text or "") if ch in "\n\t" or ord(ch) >= 32).strip()[:limit]


def load() -> dict[str, Suggestion]:
    out: dict[str, Suggestion] = {}
    for row in store.read_lines(path())[0]:
        sid = str(row.get("id") or "")
        if row.get("event") == "sent":
            out[sid] = Suggestion(id=sid, by=str(row.get("by") or ""), title=str(row.get("title") or ""), stuck=str(row.get("stuck") or ""),
                                  where_url=str(row.get("where_url") or ""), where_title=str(row.get("where_title") or ""),
                                  created_at=str(row.get("at") or ""), updated_at=str(row.get("at") or ""))
        elif sid in out and row.get("event") in ("accepted", "dismissed"):
            item = out[sid]
            item.status, item.updated_at = row["event"], str(row.get("at") or "")
            item.wish_id, item.note = row.get("wish_id"), str(row.get("note") or "")
    return out


def listing(by: Optional[str] = None) -> list[Suggestion]:
    """主人看全部；访客只看自己提的。 / The owner sees all; a visitor sees their own."""
    items = [s for s in load().values() if by is None or s.by == by]
    return sorted(items, key=lambda s: s.created_at, reverse=True)


def send(by: str, title: str, stuck: str = "", where_url: str = "", where_title: str = "") -> Suggestion:
    if not by:
        raise SuggestionError("要先登录")
    title = _clip(title, MAX_TITLE)
    if not title:
        raise SuggestionError("写一句话说你想要什么")
    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds")
    if sum(1 for s in load().values() if s.by == by and s.created_at > since) >= PER_DAY:
        raise SuggestionError(f"一天最多提 {PER_DAY} 条，明天再来")
    sid = f"sug-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(2)}"
    row: dict[str, Any] = {"at": now(), "id": sid, "event": "sent", "by": by, "title": title, "stuck": _clip(stuck, MAX_TEXT),
                           "where_url": _clip(where_url, 300) if where_url.startswith("/") else "", "where_title": _clip(where_title, MAX_TITLE)}
    store.append(path(), [row])
    notify.send("有访客提了愿望，等你过目", f"{by}：{title}", url="/wishes", tag="suggestions")
    return load()[sid]


def _waiting(suggestion_id: str) -> Suggestion:
    item = load().get(suggestion_id)
    if item is None:
        raise SuggestionError("没有这一条")
    if item.status != "waiting":
        raise SuggestionError("这一条已经处理过了")
    return item


def accept(suggestion_id: str) -> Suggestion:
    """主人看过，放进许愿池。 / The owner has looked at it; put it into the wish pool."""
    item = _waiting(suggestion_id)
    where = {"url": item.where_url, "title": item.where_title or item.where_url} if item.where_url else None
    wish_id = wishes.record(title=item.title, kind="other", stuck=item.stuck, suggestion="", by=f"visitor:{item.by}", where=where)
    store.append(path(), [{"at": now(), "id": suggestion_id, "event": "accepted", "wish_id": wish_id}])
    return load()[suggestion_id]


def dismiss(suggestion_id: str, note: str = "") -> Suggestion:
    _waiting(suggestion_id)
    store.append(path(), [{"at": now(), "id": suggestion_id, "event": "dismissed", "note": _clip(note, MAX_TEXT)}])
    return load()[suggestion_id]
