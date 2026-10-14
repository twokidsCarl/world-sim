"""许愿池：对 idea-loom 这个工具本身的改进愿望。

做法照搬 vegapunk 的许愿清单：愿望只从和小助手的对话里来；同一个问题再遇到是给原来那条
加一次，不新开；未处理时可以改写和撤销，采纳之后内容冻结，由处理它的 Claude Code 标回进度。
存成只追加的事件，当前状态由事件折叠得出。

The wish pool: wishes for improving idea-loom itself. The design follows vegapunk's
wish list: wishes only come out of conversations with the assistant; meeting the same
problem again bumps the existing wish instead of opening a new one; a wish can be
edited or withdrawn while open and is frozen once accepted, after which the Claude
Code job handling it reports progress. Stored as append-only events and folded.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from . import store

Kind = Literal["unclear", "missing", "broken", "structure", "other"]
Status = Literal["open", "accepted", "done", "declined", "withdrawn"]
KIND_LABELS: dict[str, str] = {"unclear": "界面不清楚", "missing": "缺功能", "broken": "出错", "structure": "想法池的结构该改", "other": "其它"}
STATUS_LABELS: dict[str, str] = {"open": "未处理", "accepted": "已采纳", "done": "已做完", "declined": "不做", "withdrawn": "已撤销"}
BY_LABELS: dict[str, str] = {"assistant": "小助手", "human": "你", "review": "回看", "claude-code": "Claude Code"}
EVENT_LABELS: dict[str, str] = {
    "recorded": "记下", "seen": "又遇到一次", "edited": "改写", "withdrawn": "撤销", "restored": "恢复",
    "status": "改状态", "noted": "说明", "linked": "关联",
}
# 状态分成两组：待处理的和已完结的。界面的筛选先选组，再在组里选状态。
# Statuses fall into two groups, pending and closed. The UI filter picks a group first, then a status within it.
GROUPS: dict[str, tuple[str, ...]] = {"pending": ("open", "accepted"), "closed": ("done", "declined", "withdrawn"), "all": tuple(STATUS_LABELS)}
MAX_TITLE, MAX_TEXT = 200, 2000


class WishError(ValueError):
    """这次改动做不了，原因写给人看。 / The change cannot be made; the message is for a person."""


class Where(BaseModel):
    url: str = ""
    title: str = ""


class Seen(BaseModel):
    at: str
    conversation_id: Optional[str] = None
    turn: Optional[int] = None
    question: str = ""


class Note(BaseModel):
    at: str
    by: str
    by_label: str
    text: str


class LinkItem(BaseModel):
    at: str
    by: str
    kind: Literal["plan", "pr", "job"]
    pr: Optional[int] = None
    url: Optional[str] = None
    title: str = ""


class HistoryItem(BaseModel):
    at: str
    event: str
    event_label: str
    by: str
    by_label: str
    text: str


class Wish(BaseModel):
    wish_id: str
    # 按记下的先后从 1 起的序号，给人叫的名字是 wish-N。只追加的记录不会改顺序，所以序号不会变；撤销了的也保留序号。
    # The sequence number in recording order, from 1; people call the wish wish-N. The log is append-only, so the order and hence the number never change; withdrawn wishes keep theirs.
    number: int = 0
    title: str
    kind: Kind
    kind_label: str
    stuck: str = ""
    suggestion: str = ""
    where: Optional[Where] = None
    status: Status = "open"
    status_label: str = "未处理"
    status_note: Optional[str] = None
    pr: Optional[int] = None
    source: str = "assistant"
    occurrences: int = 1
    created_at: str
    updated_at: str
    # 正在做这条愿望的作业走到哪一步；没有作业在做就都是空的。由接口那一层填，这里不存、也不算。
    # Where the job working on this wish has got to; all empty when no job is. Filled by the API layer; nothing here stores or computes them.
    job_id: Optional[str] = None
    job_phase: Optional[str] = None
    job_label: Optional[str] = None
    job_queued: bool = False


class WishDetail(Wish):
    copy_text: str
    seen: list[Seen] = Field(default_factory=list)
    notes: list[Note] = Field(default_factory=list)
    links: list[LinkItem] = Field(default_factory=list)
    history: list[HistoryItem] = Field(default_factory=list)


class WishList(BaseModel):
    wishes: list[Wish]
    counts: dict[str, int]
    kinds: dict[str, int]
    statuses: dict[str, str]
    kind_labels: dict[str, str]
    groups: dict[str, list[str]] = Field(default_factory=dict)  # 每一组里有哪些状态 / the statuses in each group
    unreadable: int = 0


def path() -> Path:
    return store.data_dir() / "wishes.jsonl"


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _clip(text: Any, limit: int) -> str:
    return str(text or "").strip()[:limit]


def fold(rows: list[dict[str, Any]]) -> dict[str, WishDetail]:
    out: dict[str, WishDetail] = {}
    for r in rows:
        wid, event, at, by = r.get("wish_id"), r.get("event"), str(r.get("at", "")), str(r.get("by", "assistant"))
        if not isinstance(wid, str) or event not in EVENT_LABELS:
            continue
        text = ""
        if event == "recorded":
            if wid in out or r.get("kind") not in KIND_LABELS:
                continue
            where = r.get("where") if isinstance(r.get("where"), dict) else None
            out[wid] = WishDetail(
                wish_id=wid, number=len(out) + 1, title=_clip(r.get("title"), MAX_TITLE), kind=r["kind"], kind_label=KIND_LABELS[r["kind"]],
                stuck=_clip(r.get("stuck"), MAX_TEXT), suggestion=_clip(r.get("suggestion"), MAX_TEXT),
                where=Where(**where) if where else None, source=by, created_at=at, updated_at=at, copy_text="",
                seen=[Seen(at=at, conversation_id=r.get("conversation_id"), turn=r.get("turn"), question=_clip(r.get("question"), MAX_TEXT))],
            )
            text = out[wid].title
        w = out.get(wid)
        if w is None:
            continue
        w.updated_at = at
        if event == "seen":
            w.occurrences += 1
            w.seen.append(Seen(at=at, conversation_id=r.get("conversation_id"), turn=r.get("turn"), question=_clip(r.get("question"), MAX_TEXT)))
            text = _clip(r.get("question"), 120)
        elif event == "edited":
            for key, limit in (("title", MAX_TITLE), ("stuck", MAX_TEXT), ("suggestion", MAX_TEXT)):
                if isinstance(r.get(key), str):
                    setattr(w, key, _clip(r[key], limit))
            if r.get("kind") in KIND_LABELS:
                w.kind, w.kind_label = r["kind"], KIND_LABELS[r["kind"]]
            text = w.title
        elif event == "withdrawn":
            w.status = "withdrawn"
        elif event == "restored":
            w.status = "open"
        elif event == "status" and r.get("status") in STATUS_LABELS:
            w.status = r["status"]
            w.status_note = _clip(r.get("note"), MAX_TEXT) or None
            if isinstance(r.get("pr"), int):
                w.pr = r["pr"]
            text = f"{STATUS_LABELS[w.status]}" + (f"：{w.status_note}" if w.status_note else "")
        elif event == "noted":
            text = _clip(r.get("text"), MAX_TEXT)
            w.notes.insert(0, Note(at=at, by=by, by_label=BY_LABELS.get(by, by), text=text))
        elif event == "linked" and r.get("kind") in ("plan", "pr", "job"):
            w.links.insert(0, LinkItem(at=at, by=by, kind=r["kind"], pr=r.get("pr") if isinstance(r.get("pr"), int) else None,
                                       url=r.get("url"), title=_clip(r.get("title"), MAX_TITLE)))
            text = _clip(r.get("title"), MAX_TITLE)
        w.history.insert(0, HistoryItem(at=at, event=event, event_label=EVENT_LABELS[event], by=by, by_label=BY_LABELS.get(by, by), text=text))
    for w in out.values():
        w.status_label = STATUS_LABELS[w.status]
        w.copy_text = (
            f"请处理 idea-loom 许愿池里的这条愿望（{name(w)}）：{w.title}\n卡在哪：{w.stuck}\n建议：{w.suggestion}\n"
            f"先读 idea-loom/README.md 和根目录的 CLAUDE.md；建议只是当时的一个想法，不一定是最好的改法。"
        )
    return out


def load() -> tuple[dict[str, WishDetail], int]:
    rows, bad = store.read_lines(path())
    return fold(rows), bad


def name(wish: Wish) -> str:
    """给人看、给人叫的名字：wish-N。 / The name people see and say: wish-N."""
    return f"wish-{wish.number}"


_NAME = re.compile(r"wish-(\d+)", re.IGNORECASE)


def resolve(ref: str, wishes: dict[str, WishDetail]) -> WishDetail:
    """把人写的编号认成一条愿望。依次试：wish-N、完整的编号、不超过总数的纯数字 N、旧编号的结尾几位。
    纯数字有歧义（"1990" 可能是第 1990 条，也可能是旧编号结尾的四位），所以只有不超过总条数时才当序号。

    Resolve what a person wrote to one wish. In order: wish-N, the full id, a bare number N
    no larger than the count, then the last few characters of an old id. A bare number is
    ambiguous ("1990" may be number 1990 or the last four of an old id), so it is taken as a
    number only when it does not exceed the count.
    """
    ref = str(ref or "").strip()
    if not ref:
        raise WishError("要给愿望的编号，比如 wish-3")
    by_number = {w.number: w for w in wishes.values()}
    named = _NAME.fullmatch(ref)
    if named:
        hit = by_number.get(int(named.group(1)))
        if hit is None:
            raise WishError(f"没有 {ref}：编号从 wish-1 到 wish-{len(wishes)}")
        return hit
    if ref in wishes:
        return wishes[ref]
    if ref.isdigit() and 1 <= int(ref) <= len(wishes):
        return by_number[int(ref)]
    hits = [w for w in wishes.values() if w.wish_id.endswith(ref)]
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise WishError(f"有好几条愿望的编号以 {ref} 结尾（{'、'.join(name(w) for w in hits)}），写 wish-N")
    raise WishError(f"没有编号为 {ref} 的愿望。写 wish-N（从 wish-1 到 wish-{len(wishes)}），或完整的编号")


def listing(status: Optional[str] = None, group: Optional[str] = None) -> WishList:
    """列出愿望。给了 status 就只列这个状态；否则列 group 这一组（pending、closed、all），缺省是待处理。

    List wishes. With a status, only that status; otherwise the given group (pending, closed, all), pending by default.
    """
    if status and status not in STATUS_LABELS:
        raise WishError("status 只能是：" + "、".join(STATUS_LABELS))
    if group and group not in GROUPS:
        raise WishError("group 只能是：" + "、".join(GROUPS))
    wishes, bad = load()
    items = list(wishes.values())
    counts = {s: sum(w.status == s for w in items) for s in STATUS_LABELS}
    wanted = (status,) if status else GROUPS[group or "pending"]
    shown = [w for w in items if w.status in wanted]
    shown.sort(key=lambda w: (-w.occurrences, w.updated_at), reverse=False)
    shown.sort(key=lambda w: w.updated_at, reverse=True)
    shown.sort(key=lambda w: -w.occurrences)
    kinds = {k: sum(w.kind == k for w in shown) for k in KIND_LABELS}
    return WishList(wishes=[Wish(**w.model_dump(include=set(Wish.model_fields))) for w in shown], counts=counts, kinds=kinds,
                    statuses=STATUS_LABELS, kind_labels=KIND_LABELS, groups={k: list(v) for k, v in GROUPS.items()}, unreadable=bad)


def pending_count() -> int:
    """待处理（未处理加已采纳）的愿望有几条，和许愿池页面默认那一组的数一样。

    How many wishes are pending (open plus accepted): the same number as the wish pool page's default group.
    """
    return sum(w.status in GROUPS["pending"] for w in load()[0].values())


def get(wish_id: str) -> WishDetail:
    """按人写的编号取一条愿望（wish-N、完整编号、N 或结尾几位，见 resolve）。
    Fetch a wish by whatever a person wrote (wish-N, the full id, N or the last few characters; see resolve)."""
    return resolve(wish_id, load()[0])


def _append(wish_id: str, event: str, by: str, **fields: Any) -> None:
    store.append(path(), [{"at": now(), "wish_id": wish_id, "event": event, "by": by, **{k: v for k, v in fields.items() if v is not None}}])


def record(*, title: str, kind: str, stuck: str, suggestion: str, by: str = "assistant", where: Optional[dict] = None,
           conversation_id: Optional[str] = None, turn: Optional[int] = None, question: str = "") -> str:
    if kind not in KIND_LABELS:
        raise WishError(f"愿望的种类只能是：{'、'.join(KIND_LABELS)}")
    if not _clip(title, MAX_TITLE):
        raise WishError("愿望要有一句话的标题")
    wish_id = f"wish-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(2)}"
    _append(wish_id, "recorded", by, title=_clip(title, MAX_TITLE), kind=kind, stuck=_clip(stuck, MAX_TEXT),
            suggestion=_clip(suggestion, MAX_TEXT), where=where, conversation_id=conversation_id, turn=turn, question=_clip(question, MAX_TEXT))
    return wish_id


def see_again(wish_id: str, *, by: str = "assistant", title: Optional[str] = None, stuck: Optional[str] = None,
              suggestion: Optional[str] = None, note: Optional[str] = None, conversation_id: Optional[str] = None,
              turn: Optional[int] = None, question: str = "") -> WishDetail:
    """同一个问题又遇到一次。未处理时可以顺便把内容改得更全；已采纳的只能加说明。

    The same problem was met again. While open the text may be widened to cover the
    new case; once accepted only a note can be added.
    """
    wish = get(wish_id)
    wish_id = wish.wish_id
    if wish.status not in ("open", "accepted"):
        raise WishError(f"这条愿望已经是「{wish.status_label}」，另记一条")
    _append(wish_id, "seen", by, conversation_id=conversation_id, turn=turn, question=_clip(question, MAX_TEXT))
    if wish.status == "open" and any(v for v in (title, stuck, suggestion)):
        _append(wish_id, "edited", by, title=title, stuck=stuck, suggestion=suggestion)
    if note and note.strip():
        _append(wish_id, "noted", by, text=_clip(note, MAX_TEXT))
    return get(wish_id)


def edit(wish_id: str, *, title: Optional[str] = None, kind: Optional[str] = None, stuck: Optional[str] = None,
         suggestion: Optional[str] = None, by: str = "human") -> None:
    wish = get(wish_id)
    wish_id = wish.wish_id
    if wish.status != "open":
        raise WishError(f"已经是「{wish.status_label}」，不能再改写。还想改，跟处理它的 Claude 说，或者让小助手另记一条。")
    if kind is not None and kind not in KIND_LABELS:
        raise WishError("没有这个种类")
    if title is not None and not title.strip():
        raise WishError("标题不能空")
    _append(wish_id, "edited", by, title=title, kind=kind, stuck=stuck, suggestion=suggestion)


def withdraw(wish_id: str, *, by: str = "human") -> None:
    wish = get(wish_id)
    if wish.status != "open":
        raise WishError(f"已经是「{wish.status_label}」，不能撤销")
    _append(wish.wish_id, "withdrawn", by)


def restore(wish_id: str, *, by: str = "human") -> None:
    wish = get(wish_id)
    if wish.status != "withdrawn":
        raise WishError("只有撤销了的愿望才能恢复")
    _append(wish.wish_id, "restored", by)


def set_status(wish_id: str, status: str, *, note: str = "", pr: Optional[int] = None, by: str = "claude-code") -> None:
    wish = get(wish_id)
    allowed = {"open": ("accepted", "declined"), "accepted": ("done", "declined", "open")}.get(wish.status, ())
    if status not in allowed:
        raise WishError(f"「{wish.status_label}」不能直接改成「{STATUS_LABELS.get(status, status)}」")
    if status == "declined" and not note.strip():
        raise WishError("标为不做要写原因")
    if status == "done" and pr is None:
        raise WishError("标为已做完要带上合并请求的编号")
    _append(wish.wish_id, "status", by, status=status, note=_clip(note, MAX_TEXT) or None, pr=pr)


def add_note(wish_id: str, text: str, *, by: str = "claude-code") -> None:
    wish_id = get(wish_id).wish_id
    if not text.strip():
        raise WishError("说明不能空")
    _append(wish_id, "noted", by, text=_clip(text, MAX_TEXT))


def add_link(wish_id: str, kind: str, *, title: str = "", url: Optional[str] = None, pr: Optional[int] = None, by: str = "claude-code") -> None:
    wish_id = get(wish_id).wish_id
    if kind not in ("plan", "pr", "job"):
        raise WishError("关联只能是方案、合并请求或作业")
    _append(wish_id, "linked", by, kind=kind, title=_clip(title, MAX_TITLE), url=url, pr=pr)


def open_titles() -> list[tuple[str, str, int, str]]:
    """未处理和已采纳的愿望：(wish-N, 标题, 遇到几次, 状态)。每次提问都带上，供小助手判断是不是同一个问题。

    Open and accepted wishes as (wish-N, title, occurrences, status), attached to every
    question so the assistant can tell whether it is the same problem.
    """
    return [(name(w), w.title, w.occurrences, w.status_label) for w in listing().wishes]
