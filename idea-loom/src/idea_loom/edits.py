"""对想法池的手动改动。每个函数先检查，再追加事件。

Manual changes to the pool. Each function validates first, then appends events.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from . import ideas
from .model import Edge, Idea, IdeaEvent, Origin


class EditError(ValueError):
    """这次改动做不了，原因写给人看。 / The change cannot be made; the message is for a person."""


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _get(pool: dict[str, Idea], idea_id: str) -> Idea:
    idea = pool.get(idea_id)
    if idea is None:
        raise EditError(f"没有编号为 {idea_id} 的 idea")
    return idea


def _check_position(level: Optional[str], threads: Optional[list[str]], kernel: Optional[str]) -> None:
    frame = ideas.load_frame()
    if level is not None and level not in {lv.id for lv in frame.levels}:
        raise EditError(f"没有 {level} 这一层")
    if threads is not None and not set(threads) <= set(ideas.THREADS):
        raise EditError("横线只能是 A 到 E")
    if kernel is not None and kernel not in {k.name for k in frame.kernels}:
        raise EditError(f"没有「{kernel}」这种内核")


def create(
    *, title: str, body: str, level: str, threads: Optional[list[str]] = None, kernel: Optional[str] = None,
    status: str = "pool", by: str = "human", origin: Optional[Origin] = None, edges: Optional[list[Edge]] = None,
) -> str:
    title, body = title.strip(), body.strip()
    if not title or not body:
        raise EditError("标题和正文都不能空")
    _check_position(level, threads, kernel)
    pool, _, _, _ = ideas.current()
    for e in edges or []:
        _get(pool, e.target)
    new_id = ideas.next_id(level, pool)
    ideas.append_events([
        IdeaEvent(at=now(), by=by, id=new_id, event="created", title=title, body=body, level=level,  # type: ignore[arg-type]
                  threads=sorted(threads or []), kernel=kernel, status=status, edges=edges or None,  # type: ignore[arg-type]
                  origin=origin or Origin(how=by))
    ])
    return new_id


def edit(idea_id: str, *, title: Optional[str] = None, body: Optional[str] = None, by: str = "human", text: Optional[str] = None) -> None:
    pool, _, _, _ = ideas.current()
    idea = _get(pool, idea_id)
    new_title = idea.title if title is None else title.strip()
    new_body = idea.body if body is None else body.strip()
    if not new_title or not new_body:
        raise EditError("标题和正文都不能空")
    if (new_title, new_body) == (idea.title, idea.body):
        return
    ideas.append_events([IdeaEvent(at=now(), by=by, id=idea_id, event="edited", title=new_title, body=new_body, text=text)])


def move(idea_id: str, *, threads: Optional[list[str]] = None, kernel: Optional[str] = None, clear_kernel: bool = False, by: str = "human") -> None:
    """改横线或内核。层由编号决定，不能改。 / Change threads or kernel. The level follows the id and cannot change."""
    pool, _, _, _ = ideas.current()
    idea = _get(pool, idea_id)
    _check_position(None, threads, kernel)
    fields: dict[str, object] = {}
    if threads is not None and sorted(threads) != idea.threads:
        fields["threads"] = sorted(threads)
    if clear_kernel and idea.kernel is not None:
        fields["kernel"] = None
    elif kernel is not None and kernel != idea.kernel:
        fields["kernel"] = kernel
    if fields:
        ideas.append_events([IdeaEvent(at=now(), by=by, id=idea_id, event="moved", **fields)])  # type: ignore[arg-type]


def merge(source_id: str, target_id: str, *, reason: str = "", by: str = "human") -> None:
    pool, _, _, _ = ideas.current()
    source, target = _get(pool, source_id), _get(pool, target_id)
    if source_id == target_id:
        raise EditError("不能并入自己")
    if source.status not in ideas.LIVE and source.status != "draft":
        raise EditError(f"{source_id} 现在是「{source.status_label}」，不能再并入别的")
    if target.status not in ideas.LIVE:
        raise EditError(f"{target_id} 现在是「{target.status_label}」，不能并进去")
    ideas.append_events([IdeaEvent(at=now(), by=by, id=source_id, event="merged_into", target=target_id, reason=reason.strip() or None)])


def discard(idea_id: str, *, reason: str = "", by: str = "human") -> None:
    pool, _, _, _ = ideas.current()
    idea = _get(pool, idea_id)
    if idea.status in ("merged", "discarded"):
        raise EditError(f"{idea_id} 已经是「{idea.status_label}」")
    ideas.append_events([IdeaEvent(at=now(), by=by, id=idea_id, event="discarded", reason=reason.strip() or None)])


def restore(idea_id: str, *, by: str = "human") -> None:
    pool, _, _, _ = ideas.current()
    idea = _get(pool, idea_id)
    if idea.status not in ("merged", "discarded"):
        raise EditError(f"{idea_id} 现在是「{idea.status_label}」，不需要恢复")
    ideas.append_events([IdeaEvent(at=now(), by=by, id=idea_id, event="restored", status="pool")])


def set_status(idea_id: str, status: str, *, by: str = "human") -> None:
    pool, _, _, _ = ideas.current()
    idea = _get(pool, idea_id)
    if status not in ("draft", "pool", "building", "built"):
        raise EditError("这个状态要用合并、丢弃或恢复来改")
    if idea.status in ("merged", "discarded"):
        raise EditError(f"{idea_id} 已经是「{idea.status_label}」，先恢复")
    if idea.status != status:
        ideas.append_events([IdeaEvent(at=now(), by=by, id=idea_id, event="status", status=status)])  # type: ignore[arg-type]


def note(idea_id: str, text: str, *, by: str = "human") -> None:
    pool, _, _, _ = ideas.current()
    _get(pool, idea_id)
    if not text.strip():
        raise EditError("说明不能空")
    ideas.append_events([IdeaEvent(at=now(), by=by, id=idea_id, event="noted", text=text.strip())])
